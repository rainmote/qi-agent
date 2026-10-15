//! Exercise the same short-lived WAL connections used by daemon RPCs and run
//! completion. SQLite 3.51.1 can deadlock in unixClose/unixIsSharingShmNode.
use rusqlite::Connection;
use std::{
    fs,
    process::{Command, Stdio},
    sync::{Arc, Barrier},
    thread,
    time::{Duration, Instant},
};
use uuid::Uuid;

#[test]
fn concurrent_wal_connections_close_without_deadlock() {
    const CHILD_DATABASE: &str = "QI_SQLITE_WAL_TEST_DATABASE";
    if let Some(path) = std::env::var_os(CHILD_DATABASE) {
        let start = Arc::new(Barrier::new(4));
        let workers: Vec<_> = (0..4)
            .map(|_| {
                let path = path.clone();
                let start = Arc::clone(&start);
                thread::spawn(move || {
                    start.wait();
                    for _ in 0..500 {
                        let db = Connection::open(&path).unwrap();
                        db.busy_timeout(Duration::from_secs(5)).unwrap();
                        let count: i64 = db
                            .query_row("SELECT count(*) FROM runs", [], |row| row.get(0))
                            .unwrap();
                        assert_eq!(count, 1);
                        // Closing the last WAL reader races with opening or
                        // closing another connection; a busy timeout cannot
                        // break an inverted mutex order inside SQLite.
                        drop(db);
                    }
                })
            })
            .collect();
        for worker in workers {
            worker.join().unwrap();
        }
        return;
    }

    let root = std::env::temp_dir().join(format!("qi-wal-{}", Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();
    let path = root.join("supervisor.sqlite");
    let db = Connection::open(&path).unwrap();
    db.execute_batch(
        "PRAGMA journal_mode=WAL; CREATE TABLE runs(id INTEGER); INSERT INTO runs VALUES(1);",
    )
    .unwrap();
    drop(db);
    // Bound a native-library deadlock in a subprocess so the test suite still
    // reports a failure and reaps the fixture instead of hanging indefinitely.
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "concurrent_wal_connections_close_without_deadlock",
            "--nocapture",
        ])
        .env(CHILD_DATABASE, &path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let started = Instant::now();
    let timed_out = loop {
        if child.try_wait().unwrap().is_some() {
            break false;
        }
        if started.elapsed() > Duration::from_secs(20) {
            child.kill().unwrap();
            break true;
        }
        thread::sleep(Duration::from_millis(20));
    };
    let output = child.wait_with_output().unwrap();
    fs::remove_dir_all(&root).unwrap();
    eprintln!(
        "SQLite {}: 2,000 concurrent WAL connection cycles",
        rusqlite::version()
    );
    assert!(
        !timed_out && output.status.success(),
        "SQLite {} WAL connection churn failed (timed_out={timed_out}): {} {}",
        rusqlite::version(),
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
