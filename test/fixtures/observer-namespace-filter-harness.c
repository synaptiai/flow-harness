/*
 * Offline check of the observer namespace restriction filter.
 *
 * The harness replaces prctl with a capture stub, so the filter is never
 * installed and no system call is filtered. A minimal classic BPF interpreter
 * then evaluates the captured program against synthetic seccomp_data records.
 * This checks filter logic only; it does not qualify kernel enforcement.
 */
#define _GNU_SOURCE
#include <sched.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/prctl.h>
#include <linux/filter.h>
#include <linux/seccomp.h>

static struct sock_filter captured[64];
static unsigned short captured_len;

static int capture_prctl(int option, unsigned long mode, struct sock_fprog *program) {
    if (option != PR_SET_SECCOMP || mode != SECCOMP_MODE_FILTER || program->len > 64) return -1;
    captured_len = program->len;
    memcpy(captured, program->filter, sizeof(captured[0]) * program->len);
    return 0;
}

#define prctl(option, mode, program) capture_prctl(option, mode, program)
#include "namespace-restriction.h"
#undef prctl

_Static_assert(FLOW_CLONE_NEWNS == CLONE_NEWNS && FLOW_CLONE_NEWCGROUP == CLONE_NEWCGROUP &&
                   FLOW_CLONE_NEWUTS == CLONE_NEWUTS && FLOW_CLONE_NEWIPC == CLONE_NEWIPC &&
                   FLOW_CLONE_NEWUSER == CLONE_NEWUSER && FLOW_CLONE_NEWPID == CLONE_NEWPID &&
                   FLOW_CLONE_NEWNET == CLONE_NEWNET && FLOW_CLONE_NEWTIME == CLONE_NEWTIME,
               "Flow namespace flags must match the Linux UAPI values");

static uint32_t evaluate(uint32_t arch, int nr, uint64_t arg0) {
    struct seccomp_data data;
    memset(&data, 0, sizeof(data));
    data.arch = arch;
    data.nr = nr;
    data.args[0] = arg0;
    uint32_t accumulator = 0;
    unsigned pc = 0;
    while (pc < captured_len) {
        struct sock_filter instruction = captured[pc];
        switch (instruction.code) {
        case BPF_LD | BPF_W | BPF_ABS:
            if (instruction.k > sizeof(data) - 4) return 0xdeadU;
            memcpy(&accumulator, (const char *)&data + instruction.k, 4);
            pc++;
            break;
        case BPF_JMP | BPF_JEQ | BPF_K:
            pc += 1 + (accumulator == instruction.k ? instruction.jt : instruction.jf);
            break;
        case BPF_JMP | BPF_JGE | BPF_K:
            pc += 1 + (accumulator >= instruction.k ? instruction.jt : instruction.jf);
            break;
        case BPF_JMP | BPF_JSET | BPF_K:
            pc += 1 + ((accumulator & instruction.k) ? instruction.jt : instruction.jf);
            break;
        case BPF_RET | BPF_K:
            return instruction.k;
        default:
            return 0xdeadU;
        }
    }
    return 0xdeadU;
}

static int failures;

static void expect_action(const char *name, uint32_t actual, uint32_t expected) {
    if (actual == expected) return;
    printf("FAIL %s: got %#x, want %#x\n", name, actual, expected);
    failures++;
}

#define X86_64 AUDIT_ARCH_X86_64
#define DENY(error) (SECCOMP_RET_ERRNO | (error))

int main(void) {
    if (install_namespace_restriction() != 0 || captured_len != FLOW_NS_INSTRUCTION_COUNT) {
        puts("FAIL capture");
        return 1;
    }
    expect_action("i386 call", evaluate(AUDIT_ARCH_I386, 20, 0), SECCOMP_RET_KILL_PROCESS);
    expect_action("x32 getpid", evaluate(X86_64, 0x40000000 | __NR_getpid, 0), DENY(ENOSYS));
    expect_action("x32 unshare", evaluate(X86_64, 0x40000000 | __NR_unshare, CLONE_NEWUSER),
                  DENY(ENOSYS));
    expect_action("getpid", evaluate(X86_64, __NR_getpid, 0), SECCOMP_RET_ALLOW);
    expect_action("setns", evaluate(X86_64, __NR_setns, 0), DENY(EPERM));
    expect_action("clone3", evaluate(X86_64, __NR_clone3, 0), DENY(ENOSYS));
    const uint64_t namespaces[] = {CLONE_NEWNS,  CLONE_NEWCGROUP, CLONE_NEWUTS, CLONE_NEWIPC,
                                   CLONE_NEWUSER, CLONE_NEWPID,   CLONE_NEWNET};
    for (unsigned i = 0; i < sizeof(namespaces) / sizeof(namespaces[0]); i++) {
        expect_action("unshare namespace", evaluate(X86_64, __NR_unshare, namespaces[i]),
                      DENY(EPERM));
        expect_action("unshare namespace with high bits",
                      evaluate(X86_64, __NR_unshare, namespaces[i] | 0xffffffff00000000ULL),
                      DENY(EPERM));
        expect_action("clone namespace", evaluate(X86_64, __NR_clone, namespaces[i] | SIGCHLD),
                      DENY(EPERM));
    }
    expect_action("unshare time namespace", evaluate(X86_64, __NR_unshare, CLONE_NEWTIME),
                  DENY(EPERM));
    expect_action("unshare without namespaces",
                  evaluate(X86_64, __NR_unshare, CLONE_FILES | CLONE_FS | CLONE_SYSVSEM),
                  SECCOMP_RET_ALLOW);
    expect_action("unshare high bits only", evaluate(X86_64, __NR_unshare, 0xffffffff00000000ULL),
                  SECCOMP_RET_ALLOW);
    expect_action("fork-style clone", evaluate(X86_64, __NR_clone, SIGCHLD), SECCOMP_RET_ALLOW);
    expect_action("thread clone",
                  evaluate(X86_64, __NR_clone,
                           CLONE_VM | CLONE_FS | CLONE_FILES | CLONE_SIGHAND | CLONE_THREAD |
                               CLONE_SYSVSEM | CLONE_SETTLS | CLONE_PARENT_SETTID |
                               CLONE_CHILD_CLEARTID),
                  SECCOMP_RET_ALLOW);
    expect_action("clone exit signal 0x80", evaluate(X86_64, __NR_clone, 0x80 | CLONE_VM),
                  SECCOMP_RET_ALLOW);
    expect_action("vfork", evaluate(X86_64, __NR_vfork, 0), SECCOMP_RET_ALLOW);
    printf("{\"instructions\":%u,\"failures\":%d}\n", captured_len, failures);
    return failures != 0;
}
