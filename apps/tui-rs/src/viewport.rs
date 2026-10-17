use std::collections::{HashMap, HashSet};

pub const HEADER_KEY: &str = "\0header";
const HISTORY_PREFIX: &str = "h:";

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ViewportMetric {
    pub key: String,
    pub height: usize,
    exact: bool,
}

impl ViewportMetric {
    pub fn header(height: usize) -> Self {
        Self {
            key: HEADER_KEY.into(),
            height: height.max(1),
            exact: true,
        }
    }

    pub fn history(id: &str, height: usize) -> Self {
        Self {
            key: history_key(id),
            height: height.max(1),
            exact: true,
        }
    }

    pub fn estimated_history(id: &str, height: usize) -> Self {
        Self {
            key: history_key(id),
            height: height.max(1),
            exact: false,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ScrollAnchor {
    key: String,
    row: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct CachedHeight {
    width: u16,
    expanded: bool,
    height: usize,
    exact: bool,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct VisibleWindow {
    pub start: usize,
    pub end: usize,
    pub crop_top: usize,
}

#[derive(Clone, Debug)]
pub struct HistoryViewport {
    anchor: Option<ScrollAnchor>,
    follow_bottom: bool,
    viewport_rows: usize,
    total_rows: usize,
    scroll_top: usize,
    metrics: Vec<ViewportMetric>,
    offsets: Vec<usize>,
    pending_target: Option<String>,
    height_cache: HashMap<String, CachedHeight>,
}

impl Default for HistoryViewport {
    fn default() -> Self {
        Self {
            anchor: None,
            follow_bottom: true,
            viewport_rows: 0,
            total_rows: 0,
            scroll_top: 0,
            metrics: Vec::new(),
            offsets: vec![0],
            pending_target: None,
            height_cache: HashMap::new(),
        }
    }
}

impl HistoryViewport {
    pub fn update_layout(&mut self, mut metrics: Vec<ViewportMetric>, viewport_rows: usize) {
        for metric in &mut metrics {
            metric.height = metric.height.max(1);
        }
        if let Some(anchor) = self.anchor.as_ref()
            && let Some(metric) = metrics.iter_mut().find(|metric| metric.key == anchor.key)
            && !metric.exact
        {
            metric.height = metric
                .height
                .max(anchor.row.saturating_add(viewport_rows.max(1)));
        }

        let previous_scroll_top = self.scroll_top;
        let mut offsets = Vec::with_capacity(metrics.len() + 1);
        offsets.push(0usize);
        for metric in &metrics {
            let next = offsets
                .last()
                .copied()
                .unwrap_or_default()
                .saturating_add(metric.height);
            offsets.push(next);
        }
        let total_rows = offsets.last().copied().unwrap_or_default();
        let max_scroll = total_rows.saturating_sub(viewport_rows);

        let target = self.pending_target.take();
        let anchored_scroll_top = target
            .as_deref()
            .and_then(|key| metric_index(&metrics, key).map(|index| offsets[index]))
            .or_else(|| {
                self.anchor.as_ref().and_then(|anchor| {
                    metric_index(&metrics, &anchor.key).map(|index| {
                        let row = if metrics[index].exact {
                            anchor.row.min(metrics[index].height.saturating_sub(1))
                        } else {
                            anchor.row
                        };
                        offsets[index].saturating_add(row)
                    })
                })
            })
            .unwrap_or(previous_scroll_top);

        self.metrics = metrics;
        self.offsets = offsets;
        self.viewport_rows = viewport_rows;
        self.total_rows = total_rows;
        self.scroll_top = if self.follow_bottom && target.is_none() {
            max_scroll
        } else {
            anchored_scroll_top.min(max_scroll)
        };
        if target.is_some() {
            self.follow_bottom = false;
        }
        self.sync_anchor();
    }

    pub fn visible_window(&self, overscan_items: usize) -> VisibleWindow {
        if self.metrics.is_empty() {
            return VisibleWindow::default();
        }
        let first_visible = self.index_for_row(self.scroll_top);
        let last_visible = self.index_for_row(
            self.scroll_top
                .saturating_add(self.viewport_rows.saturating_sub(1)),
        );
        let start = first_visible.saturating_sub(overscan_items);
        let end = last_visible
            .saturating_add(overscan_items)
            .saturating_add(1)
            .min(self.metrics.len());
        VisibleWindow {
            start,
            end,
            crop_top: self.scroll_top.saturating_sub(self.offsets[start]),
        }
    }

    pub fn scroll_by(&mut self, delta: isize) {
        let max_scroll = self.total_rows.saturating_sub(self.viewport_rows);
        let next = if delta < 0 {
            self.scroll_top.saturating_sub(delta.unsigned_abs())
        } else {
            self.scroll_top.saturating_add(delta as usize)
        }
        .min(max_scroll);
        self.scroll_top = next;
        self.follow_bottom = next >= max_scroll;
        self.pending_target = None;
        self.sync_anchor();
    }

    pub fn scroll_page(&mut self, pages: isize) {
        let rows = self.viewport_rows.max(1);
        self.scroll_by(pages.saturating_mul(rows as isize));
    }

    pub fn scroll_to_start(&mut self) {
        self.follow_bottom = false;
        self.pending_target = None;
        self.scroll_top = 0;
        self.sync_anchor();
    }

    pub fn scroll_to_end(&mut self) {
        self.follow_bottom = true;
        self.pending_target = None;
        self.scroll_top = self.total_rows.saturating_sub(self.viewport_rows);
        self.sync_anchor();
    }

    pub fn scroll_to_item(&mut self, id: &str) {
        self.follow_bottom = false;
        self.pending_target = Some(history_key(id));
    }

    pub fn cached_height(&self, id: &str, width: u16, expanded: bool) -> Option<(usize, bool)> {
        self.height_cache
            .get(id)
            .filter(|cached| cached.width == width && cached.expanded == expanded)
            .map(|cached| (cached.height, cached.exact))
    }

    pub fn record_height(
        &mut self,
        id: &str,
        width: u16,
        expanded: bool,
        height: usize,
        exact: bool,
    ) {
        self.height_cache.insert(
            id.to_owned(),
            CachedHeight {
                width,
                expanded,
                height: height.max(1),
                exact,
            },
        );
    }

    pub fn prune_height_cache<'a>(
        &mut self,
        live_count: usize,
        live_ids: impl Iterator<Item = &'a str>,
    ) {
        // Avoid rebuilding an O(history) set on every animation/streaming frame.
        // Stale entries are harmless and are compacted once the cache is clearly
        // larger than the live transcript.
        if self.height_cache.len() <= live_count.saturating_mul(2).max(8) {
            return;
        }
        let live = live_ids.map(ToOwned::to_owned).collect::<HashSet<_>>();
        self.height_cache.retain(|id, _| live.contains(id));
    }

    #[cfg(test)]
    pub fn cached_height_count(&self) -> usize {
        self.height_cache.len()
    }

    pub fn follow_bottom(&self) -> bool {
        self.follow_bottom
    }

    pub fn scroll_top(&self) -> usize {
        self.scroll_top
    }

    pub fn total_rows(&self) -> usize {
        self.total_rows
    }

    pub fn viewport_rows(&self) -> usize {
        self.viewport_rows
    }

    fn index_for_row(&self, row: usize) -> usize {
        self.offsets
            .partition_point(|offset| *offset <= row)
            .saturating_sub(1)
            .min(self.metrics.len().saturating_sub(1))
    }

    fn sync_anchor(&mut self) {
        if self.metrics.is_empty() {
            self.anchor = None;
            return;
        }
        let index = self.index_for_row(self.scroll_top);
        self.anchor = Some(ScrollAnchor {
            key: self.metrics[index].key.clone(),
            row: self.scroll_top.saturating_sub(self.offsets[index]),
        });
    }
}

fn history_key(id: &str) -> String {
    format!("{HISTORY_PREFIX}{id}")
}

fn metric_index(metrics: &[ViewportMetric], key: &str) -> Option<usize> {
    metrics.iter().position(|metric| metric.key == key)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn metrics(heights: &[usize]) -> Vec<ViewportMetric> {
        std::iter::once(ViewportMetric::header(2))
            .chain(
                heights
                    .iter()
                    .enumerate()
                    .map(|(index, height)| ViewportMetric::history(&index.to_string(), *height)),
            )
            .collect()
    }

    #[test]
    fn scrolling_is_row_based_and_reengages_bottom_follow() {
        let mut viewport = HistoryViewport::default();
        viewport.update_layout(metrics(&[10, 10]), 5);
        assert_eq!(viewport.scroll_top(), 17);
        assert!(viewport.follow_bottom());

        viewport.scroll_by(-3);
        assert_eq!(viewport.scroll_top(), 14);
        assert!(!viewport.follow_bottom());

        viewport.scroll_by(2);
        assert_eq!(viewport.scroll_top(), 16);
        assert!(!viewport.follow_bottom());
        viewport.scroll_by(1);
        assert_eq!(viewport.scroll_top(), 17);
        assert!(viewport.follow_bottom());
    }

    #[test]
    fn anchor_survives_height_changes_above_the_viewport() {
        let mut viewport = HistoryViewport::default();
        viewport.update_layout(metrics(&[4, 4, 4]), 4);
        viewport.scroll_by(-2);
        let before = viewport.visible_window(0);

        viewport.update_layout(metrics(&[10, 4, 4]), 4);
        let after = viewport.visible_window(0);
        assert_eq!(before.start, after.start);
        assert_eq!(viewport.scroll_top(), 14);
    }

    #[test]
    fn item_targets_and_visible_overscan_are_stable() {
        let mut viewport = HistoryViewport::default();
        viewport.update_layout(metrics(&[3, 8, 3]), 5);
        viewport.scroll_to_item("1");
        viewport.update_layout(metrics(&[3, 8, 3]), 5);
        assert_eq!(viewport.scroll_top(), 5);
        let window = viewport.visible_window(1);
        assert_eq!(window.start, 1);
        assert_eq!(window.end, 4);
        assert_eq!(window.crop_top, 3);
    }

    #[test]
    fn an_unmeasured_resize_keeps_a_deep_intra_item_anchor() {
        let mut viewport = HistoryViewport::default();
        viewport.update_layout(metrics(&[100, 3]), 10);
        viewport.scroll_to_item("0");
        viewport.update_layout(metrics(&[100, 3]), 10);
        viewport.scroll_by(50);
        assert_eq!(viewport.scroll_top(), 52);

        viewport.update_layout(
            vec![
                ViewportMetric::header(2),
                ViewportMetric::estimated_history("0", 3),
                ViewportMetric::estimated_history("1", 3),
            ],
            10,
        );
        assert_eq!(viewport.scroll_top(), 52);
        assert_eq!(viewport.visible_window(0).start, 1);
    }

    #[test]
    fn dynamic_measurements_do_not_become_exact_when_an_item_finishes_offscreen() {
        let mut viewport = HistoryViewport::default();
        viewport.record_height("streaming", 80, false, 12, false);
        assert_eq!(
            viewport.cached_height("streaming", 80, false),
            Some((12, false))
        );

        viewport.record_height("streaming", 80, false, 20, true);
        assert_eq!(
            viewport.cached_height("streaming", 80, false),
            Some((20, true))
        );
    }
}
