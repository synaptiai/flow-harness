#ifndef FLOW_OBSERVER_APPLICATION_H
#define FLOW_OBSERVER_APPLICATION_H

/* Flow-owned observer-only extension of the pinned apply-seccomp translation
 * unit. The ordinary upstream path is unchanged. These records describe the
 * application's kernel wait result, not policy cleanliness or repair eligibility.
 * Host admission still owns immutable ELF/runtime custody and invocation binding;
 * an open inode and a correlation token do not establish those properties. */
#if !defined(__linux__) || !defined(__x86_64__) || defined(__ILP32__)
#error "The native application observer supports Linux x64 only"
#endif

#include <sys/stat.h>
#include "observer-result.h"

extern char **environ;

/* Linux x64 rt_sigaction ABI, not the glibc struct sigaction layout. All entries
 * installed through this structure are SIG_DFL, so no restorer is necessary.
 * Kernel APIs also cover signals 32 and 33, which glibc reserves internally. */
struct flow_observer_kernel_action {
    uint64_t handler;
    uint64_t flags;
    uint64_t restorer;
    uint64_t mask;
};
_Static_assert(sizeof(struct flow_observer_kernel_action) == 32,
               "Unexpected x64 kernel signal-action layout");

static volatile sig_atomic_t flow_observer_target;
static volatile sig_atomic_t flow_observer_interrupted;
static volatile sig_atomic_t flow_observer_forward_failed;

static int flow_observer_errno(int value) {
    return value > 0 && value <= 4095 ? value : EIO;
}

static int flow_observer_identity(void) {
    uid_t real_uid, effective_uid, saved_uid;
    gid_t real_gid, effective_gid, saved_gid;
    if (getresuid(&real_uid, &effective_uid, &saved_uid) != 0 ||
        getresgid(&real_gid, &effective_gid, &saved_gid) != 0) return -1;
    /* This slice qualifies only an unprivileged non-root SRT identity. Clearing
     * ambient capabilities and executing with NNP is not a root-profile proof. */
    if (real_uid == 0 || real_gid == 0 || real_uid != effective_uid ||
        real_uid != saved_uid || real_gid != effective_gid || real_gid != saved_gid) {
        errno = EPERM; return -1;
    }
    return 0;
}

static int flow_observer_reset_signals(void) {
    const struct flow_observer_kernel_action action = {0, 0, 0, 0};
    for (int number = 1; number <= 64; ++number) {
        if (number == SIGKILL || number == SIGSTOP) continue;
        if (syscall(SYS_rt_sigaction, number, &action, NULL, sizeof(uint64_t)) != 0)
            return -1;
    }
    const uint64_t empty = 0;
    if (syscall(SYS_rt_sigprocmask, SIG_SETMASK, &empty, NULL, sizeof(empty)) != 0)
        return -1;
    flow_observer_target = 0;
    flow_observer_interrupted = 0;
    flow_observer_forward_failed = 0;
    return 0;
}

static void flow_observer_forward(int number) {
    const int saved = errno;
    flow_observer_interrupted = 1;
    if (flow_observer_target <= 0 || kill((pid_t)flow_observer_target, number) != 0)
        flow_observer_forward_failed = 1;
    errno = saved;
}

static int flow_observer_forwarders(pid_t target) {
    if (target <= 0) { errno = EINVAL; return -1; }
    flow_observer_target = (sig_atomic_t)target;
    struct sigaction action;
    memset(&action, 0, sizeof(action));
    action.sa_handler = flow_observer_forward;
    if (sigemptyset(&action.sa_mask) != 0) return -1;
    const int signals[] = {SIGTERM, SIGINT, SIGHUP, SIGQUIT, SIGUSR1, SIGUSR2};
    for (size_t index = 0; index < sizeof(signals) / sizeof(signals[0]); ++index)
        if (sigaction(signals[index], &action, NULL) != 0) return -1;
    return 0;
}

static int flow_observer_nondumpable(void) {
    if (prctl(PR_SET_DUMPABLE, 0) != 0) return -1;
    const int state = prctl(PR_GET_DUMPABLE);
    if (state < 0) return -1;
    if (state != 0) { errno = EPERM; return -1; }
    return 0;
}

static int flow_observer_cloexec(int fd) {
    const int flags = fcntl(fd, F_GETFD);
    if (flags < 0) return -1;
    return fcntl(fd, F_SETFD, flags | FD_CLOEXEC);
}

static int flow_observer_environment(void) {
    size_t total = 0;
    size_t count = 0;
    if (environ == NULL) return -1;
    for (char **entry = environ; *entry != NULL; ++entry) {
        if (++count > 256) return -1;
        const size_t length = strnlen(*entry, 65537);
        if (length > 65536 || total > 262144 - length) return -1;
        total += length;
        const char *equals = strchr(*entry, '=');
        if (equals == NULL || equals == *entry) return -1;
        const size_t name = (size_t)(equals - *entry);
        for (size_t i = 0; i < name; ++i) {
            const unsigned char c = (unsigned char)(*entry)[i];
            if (!(c == '_' || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
                  (i > 0 && c >= '0' && c <= '9'))) return -1;
        }
        const char *blocked[] = {"ARGV0", "BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS"};
        for (size_t i = 0; i < sizeof(blocked) / sizeof(blocked[0]); ++i)
            if (strlen(blocked[i]) == name && memcmp(*entry, blocked[i], name) == 0)
                return -1;
        if (strncmp(*entry, "LD_", 3) == 0 || strncmp(*entry, "DYLD_", 5) == 0 ||
            strncmp(*entry, "SRT_", 4) == 0 || strncmp(*entry, "BASH_FUNC_", 10) == 0)
            return -1;
    }
    return 0;
}

static int flow_observer_invocation(int argc, char **argv, unsigned char correlation[32]) {
    if (argc < 5 || argc > 69 || strcmp(argv[3], "--") != 0 || argv[4][0] != '/' ||
        strnlen(argv[4], 1025) > 1024 || strnlen(argv[2], 65) != 64)
        return -1;
    for (size_t i = 0; i < 32; ++i) {
        unsigned int value = 0;
        for (size_t j = 0; j < 2; ++j) {
            const unsigned char c = (unsigned char)argv[2][i * 2 + j];
            if (c >= '0' && c <= '9') value = value * 16 + c - '0';
            else if (c >= 'a' && c <= 'f') value = value * 16 + c - 'a' + 10;
            else return -1;
        }
        correlation[i] = (unsigned char)value;
    }
    size_t bytes = 0;
    for (int i = 5; i < argc; ++i) {
        const size_t length = strnlen(argv[i], 8193);
        if (length > 8192 || bytes > 32768 - length) return -1;
        bytes += length;
    }
    return flow_observer_environment();
}

static int flow_observer_result_fd(void) {
    struct stat result;
    if (fstat(3, &result) != 0) return -1;
    if (!S_ISFIFO(result.st_mode) && !S_ISSOCK(result.st_mode)) { errno = EINVAL; return -1; }
    const int flags = fcntl(3, F_GETFL);
    if (flags < 0) return -1;
    if ((flags & O_ACCMODE) == O_RDONLY || (flags & O_PATH) != 0) { errno = EINVAL; return -1; }
    if (S_ISSOCK(result.st_mode)) {
        int type = 0;
        socklen_t length = sizeof(type);
        if (getsockopt(3, SOL_SOCKET, SO_TYPE, &type, &length) != 0) return -1;
        if (length != sizeof(type) || type != SOCK_STREAM) { errno = EINVAL; return -1; }
    }
    for (int fd = 0; fd <= 2; ++fd) {
        struct stat standard;
        if (fstat(fd, &standard) != 0) return -1;
        if (standard.st_dev == result.st_dev && standard.st_ino == result.st_ino) {
            errno = EINVAL; return -1;
        }
    }
    if (flow_observer_cloexec(3) != 0) return -1;
    return fcntl(3, F_SETFL, flags | O_NONBLOCK);
}

static int flow_observer_elf_fd(void) {
    struct stat metadata;
    if (fstat(4, &metadata) != 0) return -1;
    const int flags = fcntl(4, F_GETFL);
    if (flags < 0) return -1;
    if (!S_ISREG(metadata.st_mode) || (flags & O_ACCMODE) != O_RDONLY ||
        (flags & O_PATH) != 0) { errno = EINVAL; return -1; }
    unsigned char header[64];
    if (pread(4, header, sizeof(header), 0) != (ssize_t)sizeof(header)) {
        errno = ENOEXEC; return -1;
    }
    if (memcmp(header, "\177ELF", 4) != 0 || header[4] != 2 || header[5] != 1 ||
        header[6] != 1 || (header[16] != 2 && header[16] != 3) || header[17] != 0 ||
        header[18] != 62 || header[19] != 0 || header[20] != 1 || header[21] != 0 ||
        header[22] != 0 || header[23] != 0 || header[52] != 64 || header[53] != 0) {
        errno = ENOEXEC; return -1;
    }
    return flow_observer_cloexec(4);
}

/* Each writer uses one bounded nonblocking write. Partial writes, interruption,
 * invalid endpoints and a reader that disappeared cannot be transport success. */
static int flow_observer_send(int fd, const unsigned char correlation[32],
                              uint32_t kind, uint32_t detail, uint32_t phase) {
    unsigned char frame[FLOW_OBSERVER_FRAME_BYTES];
    if (flow_observer_encode_result(frame, sizeof(frame), correlation, 32,
                                    kind, detail, phase, 0) != 0) return -1;
    return write(fd, frame, sizeof(frame)) == (ssize_t)sizeof(frame) ? 0 : -1;
}

static uint32_t flow_observer_u32(const unsigned char *bytes) {
    return (uint32_t)bytes[0] | ((uint32_t)bytes[1] << 8) |
           ((uint32_t)bytes[2] << 16) | ((uint32_t)bytes[3] << 24);
}

/* Called only after the exact writer process has been reaped. EAGAIN is not
 * EOF: it indicates an unexpected remaining writer and fails closed. */
static int flow_observer_receive(int fd, const unsigned char correlation[32],
                                 uint32_t fields[3], int allow_empty) {
    unsigned char frame[FLOW_OBSERVER_FRAME_BYTES + 1];
    const ssize_t length = read(fd, frame, sizeof(frame));
    if (length == 0 && allow_empty) return 0;
    if (length != FLOW_OBSERVER_FRAME_BYTES) return -1;
    unsigned char extra;
    if (read(fd, &extra, 1) != 0) return -1;
    fields[0] = flow_observer_u32(frame + 40);
    fields[1] = flow_observer_u32(frame + 44);
    fields[2] = flow_observer_u32(frame + 48);
    unsigned char expected[FLOW_OBSERVER_FRAME_BYTES];
    if (flow_observer_u32(frame + 52) != 0 ||
        flow_observer_encode_result(expected, sizeof(expected), correlation, 32,
                                    fields[0], fields[1], fields[2], 0) != 0 ||
        memcmp(frame, expected, sizeof(expected)) != 0) return -1;
    return 1;
}

static int flow_observer_final(const unsigned char correlation[32],
                               uint32_t kind, uint32_t detail, uint32_t phase) {
    const int delivered = flow_observer_send(3, correlation, kind, detail, phase);
    const int closed = close(3);
    return delivered == 0 && closed == 0 ? 0 : 1;
}

/* This function cannot return a normal status, including when writing or killing
 * is denied. The cached PID is captured before applying any worker filter.
 * SIGILL state is inherited from checked reset and is reset again in the worker.
 * Runtime denial/partial-write/trap controls remain required qualification. */
__attribute__((noreturn, noinline))
static void flow_observer_worker_fail(int writer, pid_t cached_pid,
                                      const unsigned char correlation[32],
                                      uint32_t kind, int error, uint32_t phase) {
    (void)flow_observer_send(writer, correlation, kind,
                             (uint32_t)flow_observer_errno(error), phase);
    if (cached_pid > 1) (void)syscall(SYS_kill, cached_pid, SIGKILL);
    for (;;) __asm__ volatile("ud2");
}

static int flow_observer_map(const char *path, const char *text) {
    const int fd = open(path, O_WRONLY | O_CLOEXEC);
    if (fd < 0) return -1;
    const size_t length = strlen(text);
    const ssize_t written = write(fd, text, length);
    const int saved = errno;
    const int closed = close(fd);
    if (written != (ssize_t)length) { errno = written < 0 ? saved : EIO; return -1; }
    return closed;
}

static int flow_observer_namespaces(void) {
    if (unshare(CLONE_NEWPID | CLONE_NEWNS) == 0)
        return flow_observer_nondumpable();
    if (errno != EPERM) return -1;
    const uid_t uid = geteuid();
    const gid_t gid = getegid();
    char uid_map[96], gid_map[96];
    const int uid_length = snprintf(uid_map, sizeof(uid_map), "%u %u 1\n", uid, uid);
    const int gid_length = snprintf(gid_map, sizeof(gid_map), "%u %u 1\n", gid, gid);
    if (uid_length <= 0 || (size_t)uid_length >= sizeof(uid_map) ||
        gid_length <= 0 || (size_t)gid_length >= sizeof(gid_map)) { errno = EOVERFLOW; return -1; }
    /* Same namespace setup as the pinned supervisor, with no ignored prctl,
     * mapping write/close or restoration failures. No worker exists yet. */
    if (prctl(PR_SET_DUMPABLE, 1) != 0) return -1;
    const int state = prctl(PR_GET_DUMPABLE);
    if (state < 0) return -1;
    if (state != 1) { errno = EPERM; return -1; }
    if (unshare(CLONE_NEWUSER) != 0 ||
        flow_observer_map("/proc/self/setgroups", "deny") != 0 ||
        flow_observer_map("/proc/self/uid_map", uid_map) != 0 ||
        flow_observer_map("/proc/self/gid_map", gid_map) != 0 ||
        flow_observer_nondumpable() != 0) return -1;
    return unshare(CLONE_NEWPID | CLONE_NEWNS);
}

static int flow_observer_wait(pid_t target, int *status) {
    pid_t result;
    do { result = waitpid(target, status, 0); } while (result < 0 && errno == EINTR);
    return result == target ? 0 : -1;
}

__attribute__((noreturn))
static void flow_observer_inner_finish(int writer, const unsigned char correlation[32],
                                       uint32_t kind, uint32_t detail, uint32_t phase) {
    const int delivered = flow_observer_send(writer, correlation, kind, detail, phase);
    const int closed = close(writer);
    _exit(delivered == 0 && closed == 0 ? 0 : 1);
}

__attribute__((noreturn))
static void flow_observer_inner(int report[2], int errors[2],
                                const unsigned char correlation[32], char **arguments) {
    if (close(3) != 0 || close(report[0]) != 0 || flow_observer_nondumpable() != 0)
        flow_observer_inner_finish(report[1], correlation, 3, flow_observer_errno(errno), 4);
    if (mount(NULL, "/", NULL, MS_REC | MS_PRIVATE, NULL) != 0 ||
        mount("proc", "/proc", "proc", MS_NOSUID | MS_NODEV | MS_NOEXEC, NULL) != 0 ||
        prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL, 0, 0, 0) != 0)
        flow_observer_inner_finish(report[1], correlation, 3, flow_observer_errno(errno), 2);
    const pid_t worker = fork();
    if (worker < 0)
        flow_observer_inner_finish(report[1], correlation, 3, flow_observer_errno(errno), 2);
    if (worker == 0) {
        const pid_t cached_pid = (pid_t)syscall(SYS_getpid);
        if (cached_pid <= 1 || flow_observer_reset_signals() != 0 ||
            close(report[1]) != 0 || close(errors[0]) != 0 ||
            flow_observer_cloexec(4) != 0 || flow_observer_cloexec(errors[1]) != 0)
            flow_observer_worker_fail(errors[1], cached_pid, correlation, 3, errno, 4);
        if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0)
            flow_observer_worker_fail(errors[1], cached_pid, correlation, 3, errno, 3);
        struct sock_fprog program = {
            .len = (unsigned short)(sizeof(unix_block_bpf) / sizeof(struct sock_filter)),
            .filter = (struct sock_filter *)unix_block_bpf,
        };
        if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program) != 0)
            flow_observer_worker_fail(errors[1], cached_pid, correlation, 3, errno, 3);
        (void)syscall(SYS_execveat, 4, "", arguments, environ, AT_EMPTY_PATH);
        flow_observer_worker_fail(errors[1], cached_pid, correlation, 4, errno, 0);
    }
    if (close(4) != 0 || close(errors[1]) != 0 || flow_observer_forwarders(worker) != 0) {
        const int error = flow_observer_errno(errno);
        (void)kill(worker, SIGKILL);
        flow_observer_inner_finish(report[1], correlation, 6, (uint32_t)error, 4);
    }
    int status;
    if (flow_observer_wait(worker, &status) != 0)
        flow_observer_inner_finish(report[1], correlation, 6, flow_observer_errno(errno), 5);
    uint32_t fields[3] = {0, 0, 0};
    const int received = flow_observer_receive(errors[0], correlation, fields, 1);
    if (close(errors[0]) != 0 || received < 0)
        flow_observer_inner_finish(report[1], correlation, 6, EPROTO, 4);
    if (flow_observer_interrupted || flow_observer_forward_failed)
        flow_observer_inner_finish(report[1], correlation, 6, EINTR, 5);
    if (received == 1) {
        if (!WIFSIGNALED(status) || (fields[0] != 3 && fields[0] != 4))
            flow_observer_inner_finish(report[1], correlation, 6, EPROTO, 4);
        flow_observer_inner_finish(report[1], correlation, fields[0], fields[1], fields[2]);
    }
    if (WIFEXITED(status))
        flow_observer_inner_finish(report[1], correlation, 1, (uint32_t)WEXITSTATUS(status), 0);
    /* A signalled worker is launch-unproven; the host must not classify this as
     * a behavioral failure without a separately qualified execution witness. */
    if (WIFSIGNALED(status))
        flow_observer_inner_finish(report[1], correlation, 2, (uint32_t)WTERMSIG(status), 0);
    flow_observer_inner_finish(report[1], correlation, 6, EPROTO, 5);
}

static int flow_observer_application_main(int argc, char **argv) {
    unsigned char correlation[32];
    if (flow_observer_invocation(argc, argv, correlation) != 0 ||
        flow_observer_result_fd() != 0) return 1;
    if (flow_observer_identity() != 0)
        return flow_observer_final(correlation, 3, flow_observer_errno(errno), 1);
    if (flow_observer_elf_fd() != 0)
        return flow_observer_final(correlation, 3, flow_observer_errno(errno), 4);
    /* Only this process's descriptor table is changed. No upper FD-number
     * assumption: reject an unsupported kernel rather than retaining handles. */
    if (syscall(SYS_close_range, 5u, UINT_MAX, 0u) != 0)
        return flow_observer_final(correlation, 3, flow_observer_errno(errno), 4);
    if (flow_observer_reset_signals() != 0 || flow_observer_nondumpable() != 0)
        return flow_observer_final(correlation, 3, flow_observer_errno(errno), 1);
    int report[2], errors[2];
    if (pipe2(report, O_CLOEXEC | O_NONBLOCK) != 0 ||
        pipe2(errors, O_CLOEXEC | O_NONBLOCK) != 0)
        return flow_observer_final(correlation, 3, flow_observer_errno(errno), 4);
    if (flow_observer_namespaces() != 0 || flow_observer_identity() != 0)
        return flow_observer_final(correlation, 3, flow_observer_errno(errno), 2);
    const pid_t inner = fork();
    if (inner < 0)
        return flow_observer_final(correlation, 3, flow_observer_errno(errno), 2);
    if (inner == 0) flow_observer_inner(report, errors, correlation, &argv[4]);
    /* Bash's final exec can leave relay children here. Never wait(-1): only
     * this exact inner init's termination establishes the required inner wait. */
    if (close(4) != 0 || close(report[1]) != 0 || close(errors[0]) != 0 ||
        close(errors[1]) != 0 || flow_observer_forwarders(inner) != 0) {
        if (kill(inner, SIGKILL) != 0) return 1;
        int discarded;
        (void)flow_observer_wait(inner, &discarded);
        return 1;
    }
    int status;
    if (flow_observer_wait(inner, &status) != 0) return 1;
    uint32_t fields[3] = {0, 0, 0};
    const int received = flow_observer_receive(report[0], correlation, fields, 0);
    if (close(report[0]) != 0 || received != 1 || !WIFEXITED(status) || WEXITSTATUS(status) != 0)
        return 1;
    if (flow_observer_interrupted || flow_observer_forward_failed)
        return flow_observer_final(correlation, 6, EINTR, 5);
    return flow_observer_final(correlation, fields[0], fields[1], fields[2]);
}

#endif
