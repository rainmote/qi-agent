use strict;
use warnings;
use POSIX qw(setsid WNOHANG);

# The guard owns the tool's group but monitors its original Babashka parent.
# A daemon group kill cannot strand this separate tool group after parent death.
shift @ARGV eq '--parent' or die "missing parent identity\n";
my $owner = shift @ARGV;
defined($owner) && $owner =~ /^\d+$/ or die "invalid parent identity\n";
shift @ARGV eq '--' or die "missing argv boundary\n";
@ARGV or die "missing command\n";
my $session = setsid();
defined($session) && $session >= 0 or die "setsid failed: $!\n";

sub terminate_group {
    $SIG{TERM} = $SIG{INT} = $SIG{HUP} = 'IGNORE';
    kill 'TERM', -$$;
    kill 'KILL', -$$;
    exit 125;
}
$SIG{TERM} = $SIG{INT} = $SIG{HUP} = \&terminate_group;
getppid() == $owner or terminate_group();
my $child = fork();
defined($child) or die "fork failed: $!\n";
if ($child == 0) {
    $SIG{TERM} = $SIG{INT} = $SIG{HUP} = 'DEFAULT';
    exec @ARGV;
    die "exec failed: $!\n";
}

my $status;
while (1) {
    getppid() == $owner or terminate_group();
    if (!defined($status) && waitpid($child, WNOHANG) == $child) {
        $status = $?;
    }
    if (defined($status)) {
        # Keep the guard alive for orphans that still own inherited pipes, even
        # when ProcessHandle polling missed their short-lived parent entirely.
        my $ps_pid = open(my $ps, '-|', '/bin/ps', '-eo', 'pid=,pgid=,stat=');
        defined($ps_pid) or terminate_group();
        my $others = 0;
        while (my $line = <$ps>) {
            my ($pid, $group, $state) = $line =~ /^\s*(\d+)\s+(\d+)\s+(\S+)/;
            next unless defined($pid);
            $others++ if $group == $$ && $pid != $$ && $pid != $ps_pid && $state !~ /^Z/;
        }
        close($ps);
        if (!$others) {
            exit(($status & 127) ? 128 + ($status & 127) : $status >> 8);
        }
    }
    select(undef, undef, undef, 0.02);
}
