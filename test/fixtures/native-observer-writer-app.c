/* Fixed Linux x64 application for private-writer qualification, not a helper.
 *
 * CLI: forge-stdout HEX64; attack-proc HEX64; attack-pidfd HEX64;
 *      control-proc HEX64; control-pidfd HEX64.
 * Correlation is deliberately disclosed. It is not writer authentication.
 * Every successful mode really exits 7; forge-stdout emits a valid normal-0
 * frame on ORDINARY stdout. No protected endpoint is written by this fixture.
 *
 * The actual target is inner init (PID 1), report writer FD 6, as established
 * by observer-application.h's close_range and report-pipe creation order.
 * A live PID plus permission denial does not independently prove FD existence
 * or uniquely attribute denial to dumpability instead of another host policy.
 * Self-owned pipe controls require real duplicate/open, writable inode identity,
 * and a 64-byte roundtrip. Same-thread-group ptrace access bypasses Yama; an
 * unavailable/filtered pidfd syscall is a failed control, never a denial pass.
 * See Linux v6.8 kernel/ptrace.c __ptrace_may_access and pidfd_getfd(2).
 *
 * The main worker and two fixed children probe independently. The second child
 * creates a new session. Both are bounded, parent-death protected and exactly
 * reaped before the summary; this is not arbitrary-descendant qualification.
 */
#define _GNU_SOURCE
#if !defined(__linux__) || !defined(__x86_64__) || defined(__ILP32__)
#error "Native observer writer controls require Linux x64"
#endif

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#include "../../native/verification-observer/observer-result.h"

enum mechanism { VIA_PROC, VIA_PIDFD };
struct observation { int error; int positive; };

static int signal_contract(void) {
    struct sigaction action;
    sigset_t mask;
    if (sigaction(SIGCHLD, NULL, &action) != 0 || action.sa_handler != SIG_DFL ||
        (action.sa_flags & SA_NOCLDWAIT) != 0 ||
        sigaction(SIGALRM, NULL, &action) != 0 || action.sa_handler != SIG_DFL ||
        sigprocmask(SIG_SETMASK, NULL, &mask) != 0 ||
        sigismember(&mask, SIGALRM) != 0) return -1;
    return 0;
}

static int entry_inventory(void) {
    for (int fd = 0; fd < 3; ++fd)
        if (fcntl(fd, F_GETFD) < 0) return -1;
    DIR *directory = opendir("/proc/self/fd");
    if (directory == NULL) return -1;
    const int own = dirfd(directory);
    int result = own >= 0 ? 0 : -1;
    unsigned int count = 0;
    while (result == 0) {
        errno = 0;
        const struct dirent *entry = readdir(directory);
        if (entry == NULL) {
            if (errno != 0) result = -1;
            break;
        }
        if (++count > 4096) { result = -1; break; }
        if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0)
            continue;
        char *end = NULL;
        errno = 0;
        const long fd = strtol(entry->d_name, &end, 10);
        if (errno != 0 || end == entry->d_name || *end != '\0' || fd < 0 ||
            fd > INT_MAX || (fd > 2 && fd != own)) result = -1;
    }
    if (closedir(directory) != 0) result = -1;
    return result;
}

static int correlation_frame(const char *text, unsigned char frame[64]) {
    if (strlen(text) != 64) return -1;
    unsigned char correlation[32];
    for (size_t i = 0; i < sizeof(correlation); ++i) {
        unsigned int value = 0;
        for (size_t j = 0; j < 2; ++j) {
            const unsigned char c = (unsigned char)text[i * 2 + j];
            if (c >= '0' && c <= '9') value = value * 16 + c - '0';
            else if (c >= 'a' && c <= 'f') value = value * 16 + c - 'a' + 10;
            else return -1;
        }
        correlation[i] = (unsigned char)value;
    }
    return flow_observer_encode_result(frame, 64, correlation, 32, 1, 0, 0, 0);
}

static int live_pidfd(int fd) {
    struct pollfd item = { .fd = fd, .events = POLLIN, .revents = 0 };
    return poll(&item, 1, 0) == 0 && item.revents == 0 ? 0 : -1;
}

static int acquire(enum mechanism method, pid_t pid, int pidfd, int target_fd) {
    if (method == VIA_PIDFD)
        return (int)syscall(SYS_pidfd_getfd, pidfd, target_fd, 0u);
    char path[96];
    const int length = snprintf(path, sizeof(path), "/proc/%ld/fd/%d", (long)pid, target_fd);
    if (length <= 0 || (size_t)length >= sizeof(path)) { errno = EOVERFLOW; return -1; }
    return open(path, O_WRONLY | O_CLOEXEC | O_NONBLOCK);
}

static int roundtrip(int duplicate, const int pipe_fds[2], const unsigned char frame[64]) {
    struct stat original, copy;
    const int flags = fcntl(duplicate, F_GETFL);
    if (flags < 0 || (flags & O_ACCMODE) != O_WRONLY ||
        fstat(pipe_fds[1], &original) != 0 || fstat(duplicate, &copy) != 0 ||
        !S_ISFIFO(original.st_mode) || !S_ISFIFO(copy.st_mode) ||
        original.st_dev != copy.st_dev || original.st_ino != copy.st_ino ||
        write(duplicate, frame, 64) != 64) return -1;
    unsigned char received[65];
    if (read(pipe_fds[0], received, sizeof(received)) != 64 ||
        memcmp(received, frame, 64) != 0) return -1;
    errno = 0;
    return read(pipe_fds[0], received, 1) == -1 && errno == EAGAIN ? 0 : -1;
}

static int probe(enum mechanism method, int accessible, const unsigned char frame[64],
                 struct observation *output) {
    int local[2] = {-1, -1};
    int self = -1, init = -1, duplicate = -1;
    int result = -1;
    if (pipe2(local, O_CLOEXEC | O_NONBLOCK) != 0) goto cleanup;
    self = (int)syscall(SYS_pidfd_open, getpid(), 0u);
    init = (int)syscall(SYS_pidfd_open, 1, 0u);
    if (self < 0 || init < 0 || live_pidfd(init) != 0) goto cleanup;
    duplicate = acquire(method, getpid(), self, local[1]);
    if (duplicate < 0 || roundtrip(duplicate, local, frame) != 0) goto cleanup;
    if (close(duplicate) != 0) { duplicate = -1; goto cleanup; }
    duplicate = -1;
    output->positive = 1;
    errno = 0;
    duplicate = acquire(method, accessible ? getpid() : 1,
                        accessible ? self : init, accessible ? local[1] : 6);
    output->error = duplicate < 0 ? errno : 0;
    if (accessible && (duplicate < 0 || roundtrip(duplicate, local, frame) != 0))
        goto cleanup;
    /* Unexpected access is reported as errno 0 and rejected by main. Do not
     * inject into the actual supervisor channel even when opening succeeds. */
    if (live_pidfd(init) != 0) goto cleanup;
    result = 0;
cleanup:
    if (duplicate >= 0 && close(duplicate) != 0) result = -1;
    if (self >= 0 && close(self) != 0) result = -1;
    if (init >= 0 && close(init) != 0) result = -1;
    for (size_t i = 0; i < 2; ++i)
        if (local[i] >= 0 && close(local[i]) != 0) result = -1;
    return result;
}

static long long milliseconds(void) {
    struct timespec now;
    if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) return -1;
    return (long long)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}

static int wait_bounded(pid_t child, int *status, int budget) {
    const long long start = milliseconds();
    if (start < 0) return -1;
    for (;;) {
        const pid_t waited = waitpid(child, status, WNOHANG);
        if (waited == child) return 0;
        if (waited < 0 && errno != EINTR) return errno == ECHILD ? -2 : -1;
        const long long now = milliseconds();
        if (now < 0 || now - start >= budget) return -1;
        const struct timespec pause = { .tv_sec = 0, .tv_nsec = 1000000 };
        if (nanosleep(&pause, NULL) != 0 && errno != EINTR) return -1;
    }
}

static int child_probe(enum mechanism method, int accessible, int new_session,
                       const unsigned char frame[64], struct observation *output) {
    int reports[2];
    if (pipe2(reports, O_CLOEXEC | O_NONBLOCK) != 0) return -1;
    const pid_t parent = getpid();
    const pid_t child = fork();
    if (child == 0) {
        alarm(1);
        if (prctl(PR_SET_PDEATHSIG, SIGKILL) != 0 || getppid() != parent ||
            close(reports[0]) != 0 || (new_session && setsid() != getpid())) _exit(101);
        struct observation observed = {0, 0};
        if (probe(method, accessible, frame, &observed) != 0 || getppid() != parent ||
            observed.error < 0 || observed.error > 4095) _exit(102);
        /* Fixed test-only child report, not the production private frame. */
        const unsigned char report[4] = {
            (unsigned char)observed.error, (unsigned char)(observed.error >> 8),
            (unsigned char)observed.positive, 0
        };
        const ssize_t written = write(reports[1], report, sizeof(report));
        const int closed = close(reports[1]);
        _exit(written == (ssize_t)sizeof(report) && closed == 0 ? 0 : 103);
    }
    int result = -1, status = 0, reaped = 0, lost_child = 0;
    if (close(reports[1]) != 0 || child < 0) goto cleanup;
    const int waited = wait_bounded(child, &status, 750);
    if (waited != 0) { lost_child = waited == -2; goto cleanup; }
    reaped = 1;
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) goto cleanup;
    unsigned char report[5];
    if (read(reports[0], report, sizeof(report)) != 4 || report[2] != 1 || report[3] != 0)
        goto cleanup;
    output->error = report[0] | ((int)report[1] << 8);
    output->positive = 1;
    if (read(reports[0], report, 1) != 0) goto cleanup;
    result = 0;
cleanup:
    if (child > 0 && !reaped && !lost_child) {
        /* Only this exact owned child is signalled, including its setsid case. */
        (void)kill(child, SIGKILL);
        (void)wait_bounded(child, &status, 250);
    }
    if (close(reports[0]) != 0) result = -1;
    return result;
}

int main(int argc, char **argv) {
    if (signal_contract() != 0) return 110;
    alarm(3);
    if (argc != 3 || getpid() <= 1 || getppid() != 1 || entry_inventory() != 0) return 110;
    unsigned char frame[64];
    if (correlation_frame(argv[2], frame) != 0) return 111;
    if (strcmp(argv[1], "forge-stdout") == 0)
        return write(STDOUT_FILENO, frame, sizeof(frame)) == (ssize_t)sizeof(frame) ? 7 : 112;
    enum mechanism method;
    int accessible;
    if (strcmp(argv[1], "attack-proc") == 0) { method = VIA_PROC; accessible = 0; }
    else if (strcmp(argv[1], "attack-pidfd") == 0) { method = VIA_PIDFD; accessible = 0; }
    else if (strcmp(argv[1], "control-proc") == 0) { method = VIA_PROC; accessible = 1; }
    else if (strcmp(argv[1], "control-pidfd") == 0) { method = VIA_PIDFD; accessible = 1; }
    else return 111;
    struct observation worker = {0, 0}, ordinary = {0, 0}, session = {0, 0};
    if (probe(method, accessible, frame, &worker) != 0 ||
        child_probe(method, accessible, 0, frame, &ordinary) != 0 ||
        child_probe(method, accessible, 1, frame, &session) != 0 || getppid() != 1) return 113;
    char summary[512];
    const int length = snprintf(summary, sizeof(summary),
        "{\"mechanism\":\"%s\",\"control\":%s,"
        "\"worker\":{\"errno\":%d,\"positiveRoundtrip\":true},"
        "\"ordinary\":{\"errno\":%d,\"positiveRoundtrip\":true},"
        "\"newSession\":{\"errno\":%d,\"positiveRoundtrip\":true},\"childrenReaped\":true}\n",
        method == VIA_PROC ? "proc" : "pidfd", accessible ? "true" : "false",
        worker.error, ordinary.error, session.error);
    if (length <= 0 || (size_t)length >= sizeof(summary) ||
        write(STDOUT_FILENO, summary, (size_t)length) != length) return 112;
    const struct observation all[] = {worker, ordinary, session};
    for (size_t i = 0; i < sizeof(all) / sizeof(all[0]); ++i)
        if (accessible ? all[i].error != 0 :
            (all[i].error != EPERM && all[i].error != EACCES)) return 114;
    return 7;
}
