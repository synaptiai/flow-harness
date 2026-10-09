/*
 * namespace-restriction.h - Flow observer namespace restriction filter
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * The patched apply-seccomp worker installs this filter after the helper's
 * own trusted namespace and mount setup, immediately before the workload
 * filter and execvp. From that point the workload and every descendant can
 * neither create nor join a namespace:
 *
 *   - A system call with an architecture other than x86-64, for example an
 *     i386 call through int 0x80, kills the process.
 *   - Every x32 system call returns ENOSYS.
 *   - setns returns EPERM, whatever the descriptor or namespace type.
 *   - clone3 returns ENOSYS. Its flags live in user memory that a filter
 *     cannot inspect safely, and C libraries fall back to clone.
 *   - unshare and clone return EPERM when any namespace flag is set.
 *
 * Calls without namespace flags are unchanged, so ordinary processes and
 * threads keep working. The filter does not record denied calls. Denials
 * outrank the upstream USER_NOTIF observation filter, so they are not
 * observed either. Policy-interference observation remains a separate gate.
 */
#ifndef FLOW_NAMESPACE_RESTRICTION_H
#define FLOW_NAMESPACE_RESTRICTION_H

#include <errno.h>
#include <stddef.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>

#if !defined(__x86_64__) || defined(__ILP32__)
#error "Linux x64 only"
#endif

#ifndef SECCOMP_RET_KILL_PROCESS
#define SECCOMP_RET_KILL_PROCESS 0x80000000U
#endif

/* Linux UAPI namespace flag values, independent of _GNU_SOURCE. */
#define FLOW_CLONE_NEWTIME 0x00000080U
#define FLOW_CLONE_NEWNS 0x00020000U
#define FLOW_CLONE_NEWCGROUP 0x02000000U
#define FLOW_CLONE_NEWUTS 0x04000000U
#define FLOW_CLONE_NEWIPC 0x08000000U
#define FLOW_CLONE_NEWUSER 0x10000000U
#define FLOW_CLONE_NEWPID 0x20000000U
#define FLOW_CLONE_NEWNET 0x40000000U

/* clone() carries the exit signal in its low byte, so CLONE_NEWTIME is
 * reachable only through unshare and clone3. */
#define FLOW_CLONE_NAMESPACE_FLAGS                                             \
    (FLOW_CLONE_NEWNS | FLOW_CLONE_NEWCGROUP | FLOW_CLONE_NEWUTS |             \
     FLOW_CLONE_NEWIPC | FLOW_CLONE_NEWUSER | FLOW_CLONE_NEWPID |              \
     FLOW_CLONE_NEWNET)
#define FLOW_UNSHARE_NAMESPACE_FLAGS (FLOW_CLONE_NAMESPACE_FLAGS | FLOW_CLONE_NEWTIME)
#define FLOW_X32_SYSCALL_BIT 0x40000000U

/* Every namespace flag sits in the low 32 bits of the first argument, which
 * x86-64 stores first. Higher bits cannot request a namespace. */
#define FLOW_ARG0_LOW offsetof(struct seccomp_data, args[0])

enum {
    FLOW_NS_LOAD_ARCH,
    FLOW_NS_CHECK_ARCH,
    FLOW_NS_KILL_ARCH,
    FLOW_NS_LOAD_NR,
    FLOW_NS_CHECK_X32,
    FLOW_NS_CHECK_SETNS,
    FLOW_NS_CHECK_CLONE3,
    FLOW_NS_CHECK_UNSHARE,
    FLOW_NS_CHECK_CLONE,
    FLOW_NS_ALLOW_OTHER,
    FLOW_NS_LOAD_UNSHARE_FLAGS,
    FLOW_NS_TEST_UNSHARE_FLAGS,
    FLOW_NS_ALLOW_UNSHARE,
    FLOW_NS_LOAD_CLONE_FLAGS,
    FLOW_NS_TEST_CLONE_FLAGS,
    FLOW_NS_ALLOW_CLONE,
    FLOW_NS_DENY_EPERM,
    FLOW_NS_DENY_ENOSYS,
    FLOW_NS_INSTRUCTION_COUNT
};

/* Classic BPF jumps are forward-only offsets from the next instruction. */
#define FLOW_NS_TO(from, to) ((unsigned char)((to) - (from) - 1))

/* Returns 0 after installing the filter, or -1 with errno set. The caller
 * must already have set PR_SET_NO_NEW_PRIVS and must fail closed on -1. */
static int install_namespace_restriction(void) {
    struct sock_filter filter[] = {
        [FLOW_NS_LOAD_ARCH] =
            BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
        [FLOW_NS_CHECK_ARCH] =
            BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64,
                     FLOW_NS_TO(FLOW_NS_CHECK_ARCH, FLOW_NS_LOAD_NR), 0),
        [FLOW_NS_KILL_ARCH] = BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
        [FLOW_NS_LOAD_NR] =
            BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
        [FLOW_NS_CHECK_X32] =
            BPF_JUMP(BPF_JMP | BPF_JGE | BPF_K, FLOW_X32_SYSCALL_BIT,
                     FLOW_NS_TO(FLOW_NS_CHECK_X32, FLOW_NS_DENY_ENOSYS), 0),
        [FLOW_NS_CHECK_SETNS] =
            BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_setns,
                     FLOW_NS_TO(FLOW_NS_CHECK_SETNS, FLOW_NS_DENY_EPERM), 0),
        [FLOW_NS_CHECK_CLONE3] =
            BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_clone3,
                     FLOW_NS_TO(FLOW_NS_CHECK_CLONE3, FLOW_NS_DENY_ENOSYS), 0),
        [FLOW_NS_CHECK_UNSHARE] =
            BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_unshare,
                     FLOW_NS_TO(FLOW_NS_CHECK_UNSHARE, FLOW_NS_LOAD_UNSHARE_FLAGS), 0),
        [FLOW_NS_CHECK_CLONE] =
            BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_clone,
                     FLOW_NS_TO(FLOW_NS_CHECK_CLONE, FLOW_NS_LOAD_CLONE_FLAGS), 0),
        [FLOW_NS_ALLOW_OTHER] = BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
        [FLOW_NS_LOAD_UNSHARE_FLAGS] =
            BPF_STMT(BPF_LD | BPF_W | BPF_ABS, FLOW_ARG0_LOW),
        [FLOW_NS_TEST_UNSHARE_FLAGS] =
            BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, FLOW_UNSHARE_NAMESPACE_FLAGS,
                     FLOW_NS_TO(FLOW_NS_TEST_UNSHARE_FLAGS, FLOW_NS_DENY_EPERM), 0),
        [FLOW_NS_ALLOW_UNSHARE] = BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
        [FLOW_NS_LOAD_CLONE_FLAGS] =
            BPF_STMT(BPF_LD | BPF_W | BPF_ABS, FLOW_ARG0_LOW),
        [FLOW_NS_TEST_CLONE_FLAGS] =
            BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, FLOW_CLONE_NAMESPACE_FLAGS,
                     FLOW_NS_TO(FLOW_NS_TEST_CLONE_FLAGS, FLOW_NS_DENY_EPERM), 0),
        [FLOW_NS_ALLOW_CLONE] = BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
        [FLOW_NS_DENY_EPERM] = BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
        [FLOW_NS_DENY_ENOSYS] = BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | ENOSYS),
    };
    _Static_assert(sizeof(filter) / sizeof(filter[0]) == FLOW_NS_INSTRUCTION_COUNT,
                   "namespace restriction filter layout");
    struct sock_fprog program = {
        .len = (unsigned short)FLOW_NS_INSTRUCTION_COUNT,
        .filter = filter,
    };
    return prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program) < 0 ? -1 : 0;
}

#endif
