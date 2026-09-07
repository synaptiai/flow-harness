/* Trusted TEST launcher, never a production helper or application substitute.
 * Compile statically for Linux x64 and insert only at the exact post-rewrite
 * bootstrap helper position INSIDE the already-admitted bwrap invocation:
 *   launcher MODE /absolute/helper --flow-observer-v1 CORRELATION -- APP ARGS...
 * The runtime test must preserve every bwrap option and bootstrap script byte.
 *
 * Modes: passthrough; deny-exec; deny-exec-write; deny-exec-write-kill;
 * close-app-fd. The latter validates the live application descriptor and canary
 * before closing FD 4, producing a genuinely absent-descriptor control.
 * Also: signal-{ignored,blocked}-{passthrough,deny-exec,deny-exec-write,
 * deny-exec-write-kill,control}. TERM/PIPE/ILL state is installed and read back
 * immediately before execution. Control execs THIS fixed launcher, not the
 * production helper, and proves self-TERM returns normally with exit 99.
 * Only blocked TERM is pending afterward. No control fabricates a result frame.
 * Caught-handler reset on exec is not qualified. In particular a synchronous
 * SIGILL outcome alone cannot prove that inherited signal state was reset.
 * Terminal-reporting modes deny-final-write, deny-inner-write, deny-outer-read,
 * and deny-worker-read target write(3), write(6), read(5), and read(7). These
 * filters apply to every inheriting process, not authenticated process roles.
 * The fixed static application must still complete with its exact marker.
 * Invocation controls alter only a calibrated helper argument or provide one
 * fixed environment entry after shell startup. They never change the helper
 * executable or held application descriptor. invoke-valid-env is the matching
 * positive control for the one-entry environment, not an invocation fault.
 *
 * FD 8 is deliberately coupled to observer-application.h's checked topology:
 * close_range(5..UINT_MAX), report pipe 5/6, then worker error pipe 7/8.
 * An implementation change requires recalibration, not a weaker assertion.
 * Passthrough MUST yield normal exit 7 and no inherited canary in the app;
 * denial modes MUST yield exec_failed EPERM, signalled SIGKILL, and signalled
 * SIGILL respectively. Signals remain launch-unproven. These controls do not
 * establish policy cleanliness or qualify arbitrary applications.
 */
#define _GNU_SOURCE
#if !defined(__linux__) || !defined(__x86_64__) || defined(__ILP32__)
#error "Native observer fault controls require Linux x64"
#endif

#include <errno.h>
#include <fcntl.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <limits.h>
#include <signal.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

extern char **environ;

static int mode_number(const char *name) {
    static const char *const names[] = {
        "passthrough", "deny-exec", "deny-exec-write",
        "deny-exec-write-kill", "close-app-fd",
        "signal-ignored-passthrough", "signal-ignored-deny-exec",
        "signal-ignored-deny-exec-write", "signal-ignored-deny-exec-write-kill",
        "signal-ignored-control", "signal-blocked-passthrough",
        "signal-blocked-deny-exec", "signal-blocked-deny-exec-write",
        "signal-blocked-deny-exec-write-kill", "signal-blocked-control",
        "deny-final-write", "deny-inner-write", "deny-outer-read", "deny-worker-read",
        "invoke-short-correlation", "invoke-invalid-correlation",
        "invoke-invalid-separator", "invoke-relative-application",
        "invoke-invalid-env-name", "invoke-env-no-equals", "invoke-valid-env"
    };
    for (unsigned int i = 0; i < sizeof(names) / sizeof(names[0]); ++i)
        if (strcmp(name, names[i]) == 0) return (int)i;
    return -1;
}

static int same_inode(const struct stat *a, const struct stat *b) {
    return a->st_dev == b->st_dev && a->st_ino == b->st_ino;
}

static int topology(void) {
    struct stat application, canary, result, own_pid_namespace, init_pid_namespace;
    const int canary_flags = fcntl(19, F_GETFD);
    const int application_flags = fcntl(4, F_GETFD);
    const int application_access = fcntl(4, F_GETFL);
    const int result_flags = fcntl(3, F_GETFD);
    const int result_access = fcntl(3, F_GETFL);
    if (canary_flags < 0 || (canary_flags & FD_CLOEXEC) != 0 ||
        application_flags < 0 || (application_flags & FD_CLOEXEC) != 0 ||
        application_access < 0 || (application_access & O_ACCMODE) != O_RDONLY ||
        result_flags < 0 || (result_flags & FD_CLOEXEC) != 0 || result_access < 0 ||
        (result_access & O_ACCMODE) == O_RDONLY ||
        fstat(4, &application) != 0 || !S_ISREG(application.st_mode) ||
        fstat(19, &canary) != 0 || !S_ISREG(canary.st_mode) ||
        !same_inode(&application, &canary) || fstat(3, &result) != 0 ||
        (!S_ISFIFO(result.st_mode) && !S_ISSOCK(result.st_mode))) return -1;
    for (int fd = 0; fd < 3; ++fd)
        if (fcntl(fd, F_GETFD) < 0) return -1;

    /* This is a calibration for the pinned bwrap profile, not generic namespace
     * detection or authentication. An outside-bwrap placement must fail before
     * the armed marker. The separate positive control checks the entire path. */
    if (getpid() <= 1 || stat("/proc/self/ns/pid", &own_pid_namespace) != 0 ||
        stat("/proc/1/ns/pid", &init_pid_namespace) != 0 ||
        !same_inode(&own_pid_namespace, &init_pid_namespace)) return -1;
    const int comm = open("/proc/1/comm", O_RDONLY | O_CLOEXEC);
    if (comm < 0) return -1;
    char name[32];
    const ssize_t length = read(comm, name, sizeof(name));
    const int closed = close(comm);
    return length == 6 && memcmp(name, "bwrap\n", 6) == 0 && closed == 0 ? 0 : -1;
}

static int install_filter(int mode) {
    struct sock_filter filters[24];
    unsigned short count = 0;
#define STMT(code, value) \
    do { filters[count++] = (struct sock_filter)BPF_STMT(code, value); } while (0)
#define JUMP(code, value, yes, no) \
    do { filters[count++] = (struct sock_filter)BPF_JUMP(code, value, yes, no); } while (0)
    STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch));
    JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 1, 0);
    STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS);
    STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr));
    /* Reject x32 instead of letting its syscall-number bit bypass a denial. */
    JUMP(BPF_JMP | BPF_JSET | BPF_K, UINT32_C(0x40000000), 0, 1);
    STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS);
    if (mode >= 1 && mode <= 3) {
        JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_execveat, 0, 1);
        STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM);
    }
    if (mode == 2 || mode == 3) {
        JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_write, 0, 3);
        /* write's fd is an int: compare the low 32 bits, not a guessed pointer. */
        STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0]));
        JUMP(BPF_JMP | BPF_JEQ | BPF_K, 8, 0, 1);
        STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM);
    }
    if (mode == 3) {
        STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr));
        JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_kill, 0, 1);
        STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM);
    }
    if (mode >= 15 && mode <= 18) {
        const unsigned int descriptors[] = {3, 6, 5, 7};
        const unsigned int operation = mode <= 16 ? SYS_write : SYS_read;
        STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr));
        JUMP(BPF_JMP | BPF_JEQ | BPF_K, operation, 0, 3);
        STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0]));
        JUMP(BPF_JMP | BPF_JEQ | BPF_K, descriptors[mode - 15], 0, 1);
        STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM);
    }
    STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW);
#undef STMT
#undef JUMP
    const struct sock_fprog program = { .len = count, .filter = filters };
    return prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) == 0 &&
        prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program) == 0 ? 0 : -1;
}

static int write_all(const char *text) {
    size_t remaining = strlen(text);
    while (remaining != 0) {
        const ssize_t written = write(STDERR_FILENO, text, remaining);
        if (written < 0 && errno == EINTR) continue;
        if (written <= 0) return -1;
        text += written;
        remaining -= (size_t)written;
    }
    return 0;
}

static uint64_t controlled_mask(void) {
    return (UINT64_C(1) << (SIGTERM - 1)) | (UINT64_C(1) << (SIGPIPE - 1)) |
        (UINT64_C(1) << (SIGILL - 1));
}

static int inspect_signals(int state) {
    const int signals[] = {SIGTERM, SIGPIPE, SIGILL};
    for (size_t i = 0; i < sizeof(signals) / sizeof(signals[0]); ++i) {
        struct sigaction action;
        if (sigaction(signals[i], NULL, &action) != 0 ||
            action.sa_handler != (state == 1 ? SIG_IGN : SIG_DFL)) return -1;
    }
    struct sigaction alarm_action, child_action;
    uint64_t mask = 0;
    if (sigaction(SIGALRM, NULL, &alarm_action) != 0 || alarm_action.sa_handler != SIG_DFL ||
        sigaction(SIGCHLD, NULL, &child_action) != 0 || child_action.sa_handler != SIG_DFL ||
        (child_action.sa_flags & SA_NOCLDWAIT) != 0 ||
        syscall(SYS_rt_sigprocmask, SIG_SETMASK, NULL, &mask, sizeof(mask)) != 0)
        return -1;
    return mask == (state == 2 ? controlled_mask() : 0) ? 0 : -1;
}

static int install_signals(int state) {
    struct sigaction action;
    memset(&action, 0, sizeof(action));
    if (sigemptyset(&action.sa_mask) != 0) return -1;
    action.sa_handler = SIG_DFL;
    if (sigaction(SIGALRM, &action, NULL) != 0 || sigaction(SIGCHLD, &action, NULL) != 0)
        return -1;
    action.sa_handler = state == 1 ? SIG_IGN : SIG_DFL;
    const int signals[] = {SIGTERM, SIGPIPE, SIGILL};
    for (size_t i = 0; i < sizeof(signals) / sizeof(signals[0]); ++i)
        if (sigaction(signals[i], &action, NULL) != 0) return -1;
    const uint64_t mask = state == 2 ? controlled_mask() : 0;
    return syscall(SYS_rt_sigprocmask, SIG_SETMASK, &mask, NULL, sizeof(mask)) == 0 &&
        inspect_signals(state) == 0 ? 0 : -1;
}

static int signal_control_child(const char *name) {
    const int state = strcmp(name, "ignored") == 0 ? 1 : strcmp(name, "blocked") == 0 ? 2 : 0;
    int death_signal = 0;
    if (state == 0 || syscall(SYS_close_range, 3u, UINT_MAX, 0u) != 0 ||
        prctl(PR_GET_PDEATHSIG, &death_signal) != 0 || death_signal != SIGKILL ||
        getppid() <= 1 || inspect_signals(state) != 0) return 123;
    alarm(2); // ALRM is verified default and unblocked in both states.
    uint64_t pending = 0;
    if (syscall(SYS_rt_sigpending, &pending, sizeof(pending)) != 0 ||
        (pending & controlled_mask()) != 0) return 124;
    const pid_t self = getpid();
    if (self <= 1 || syscall(SYS_kill, self, SIGTERM) != 0 || inspect_signals(state) != 0 ||
        syscall(SYS_rt_sigpending, &pending, sizeof(pending)) != 0) return 125;
    const uint64_t expected = state == 2 ? UINT64_C(1) << (SIGTERM - 1) : 0;
    if ((pending & controlled_mask()) != expected) return 126;
    return 99; // Real normal exit after signal delivery, never a private frame.
}

static long long signal_milliseconds(void) {
    struct timespec now;
    if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) return -1;
    return (long long)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}

static int signal_wait(pid_t child, int *status, int budget) {
    const long long start = signal_milliseconds();
    if (start < 0) return -1;
    for (;;) {
        const pid_t waited = waitpid(child, status, WNOHANG);
        if (waited == child) return 0;
        if (waited < 0 && errno != EINTR) return errno == ECHILD ? -2 : -1;
        const long long now = signal_milliseconds();
        if (now < 0 || now - start >= budget) return -1;
        const struct timespec pause = { .tv_sec = 0, .tv_nsec = 1000000 };
        if (nanosleep(&pause, NULL) != 0 && errno != EINTR) return -1;
    }
}

static int run_signal_control(int state) {
    alarm(3);
    /* Descriptor execution binds the child to this actual launcher ELF, not
     * argv[0], a caller-selected command, PATH lookup or a shell. */
    const int executable = open("/proc/self/exe", O_RDONLY | O_CLOEXEC);
    if (executable < 0) return -1;
    const pid_t parent = getpid();
    const pid_t child = fork();
    if (child == 0) {
        if (prctl(PR_SET_PDEATHSIG, SIGKILL) != 0 || getppid() != parent) _exit(127);
        char *arguments[] = {
            "flow-observer-signal-control", "--signal-control-child",
            state == 1 ? "ignored" : "blocked", NULL
        };
        char *environment[] = {"LANG=C", "LC_ALL=C", NULL};
        (void)syscall(SYS_execveat, executable, "", arguments, environment, AT_EMPTY_PATH);
        _exit(127);
    }
    const int closed = close(executable);
    if (child < 0) return -1;
    int status = 0;
    const int waited = signal_wait(child, &status, 1000);
    if (waited != 0 && waited != -2) {
        (void)kill(child, SIGKILL); // Only the exact still-owned child.
        (void)signal_wait(child, &status, 250);
    }
    if (closed != 0 || waited != 0 || !WIFEXITED(status) || WEXITSTATUS(status) != 99)
        return -1;
    return write_all(state == 1
        ? "flow-observer-signal-control:ignored:term-returned-exit-99\n"
        : "flow-observer-signal-control:blocked:term-returned-exit-99\n");
}

int main(int argc, char **argv) {
    if (argc == 3 && strcmp(argv[1], "--signal-control-child") == 0)
        return signal_control_child(argv[2]);
    if (argc < 7 || argc > 71 || argv[2][0] != '/' ||
        strcmp(argv[3], "--flow-observer-v1") != 0 ||
        strlen(argv[4]) != 64 || strcmp(argv[5], "--") != 0 || argv[6][0] != '/') return 120;
    const int mode = mode_number(argv[1]);
    if (mode < 0) return 120;
    for (unsigned int i = 0; i < 64; ++i)
        if (!((argv[4][i] >= '0' && argv[4][i] <= '9') ||
              (argv[4][i] >= 'a' && argv[4][i] <= 'f'))) return 120;
    const int signal_state = mode >= 5 && mode < 15 ? (mode < 10 ? 1 : 2) : 0;
    const int control = signal_state != 0 && (mode - 5) % 5 == 4;
    const int filter_mode = mode >= 19 ? 0 : signal_state == 0 ? mode : control ? 0 : (mode - 5) % 5;
    if (topology() != 0 || install_filter(filter_mode) != 0 ||
        (signal_state != 0 && install_signals(signal_state) != 0)) return 121;
    if (mode == 4 && close(4) != 0) return 121;
    if (write_all("flow-observer-fault:") != 0 || write_all(argv[1]) != 0 ||
        write_all(":canary=live-regular-matches-app\n") != 0) return 121;
    if (control) return run_signal_control(signal_state) == 0 ? 0 : 121;
    char *fixed_environment[] = {"FLOW_OBSERVER_QUALIFICATION=value", NULL};
    char **helper_environment = environ;
    /* argv strings and pointers belong to this fixed launcher. All mutation
     * follows its original invocation/descriptor checks; the valid host-side
     * correlation and the actual application FD remain unchanged. */
    switch (mode) {
        case 19: argv[4][63] = '\0'; break;
        case 20: argv[4][0] = 'g'; break;
        case 21: argv[5] = "invalid-separator"; break;
        case 22: argv[6] = "flow-observer-relative-application"; break;
        case 23:
            fixed_environment[0] = "1FLOW_OBSERVER_QUALIFICATION=value";
            helper_environment = fixed_environment;
            break;
        case 24:
            fixed_environment[0] = "FLOW_OBSERVER_QUALIFICATION";
            helper_environment = fixed_environment;
            break;
        case 25: helper_environment = fixed_environment; break;
        default: break;
    }
    /* execve is permitted in every mode. Only selected execution-fault modes
     * deny the helper's application execveat; invocation modes alter only the
     * arguments/environment above. The helper executable remains unchanged. */
    execve(argv[2], &argv[2], helper_environment);
    return 122;
}
