/* POSIX run owner. Linux subreaping retains even setsid/double-fork descendants.
 * Only children owned by this dedicated supervisor are enumerated or signalled. */
#define _DEFAULT_SOURCE
#include <sys/types.h>
#include <sys/wait.h>
#include <signal.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <errno.h>
#include <string.h>
#ifdef __linux__
#include <sys/prctl.h>
#endif

static int stop_requested(const char *dir) {
    char path[4096];
    snprintf(path, sizeof(path), "%s/stop", dir);
    return access(path, F_OK) == 0;
}
static int kill_owned(pid_t root) {
    int remaining = 0;
#ifdef __linux__
    char path[128];
    snprintf(path, sizeof(path), "/proc/self/task/%d/children", getpid());
    FILE *children = fopen(path, "r");
    if (!children) { fprintf(stderr, "[process-run] WARNING: cannot account for descendants of PID %d: %s\n", root, strerror(errno)); exit(127); }
    int pid;
    while (fscanf(children, "%d", &pid) == 1) {
        if (pid == root) continue; /* Keep the root zombie pinned until the final group kill. */
        /* Unreaped children cannot have their PIDs recycled. */
        if (kill(pid, SIGKILL) && errno != ESRCH)
            fprintf(stderr, "[process-run] WARNING: cannot kill owned PID %d: %s\n", pid, strerror(errno));
        int ignored;
        waitpid(pid, &ignored, WNOHANG);
        remaining++; /* Re-snapshot after reaping: grandchildren may have just been adopted. */
    }
    fclose(children);
#endif
    return remaining;
}
int main(int argc, char **argv) {
    if (argc < 3) return 127;
#ifdef __linux__
    if (prctl(PR_SET_CHILD_SUBREAPER, 1)) { perror("[process-run] WARNING: subreaper"); return 127; }
    char children_path[128];
    snprintf(children_path, sizeof(children_path), "/proc/self/task/%d/children", getpid());
    FILE *probe = fopen(children_path, "r");
    if (!probe) { perror("[process-run] WARNING: cannot account for descendants via procfs"); return 127; }
    fclose(probe);
#else
    fprintf(stderr, "[process-run] WARNING: detached descendants of %s cannot be accounted for on this OS; process-group cleanup only\n", argv[2]);
#endif
    pid_t root = fork();
    if (root < 0) { perror("fork"); return 127; }
    if (!root) {
        if (setsid() < 0) _exit(127);
        if (stop_requested(argv[1])) _exit(127);
        execvp(argv[2], argv + 2);
        perror(argv[2]);
        _exit(127);
    }
    int status = 0;
    for (;;) {
        siginfo_t info;
        memset(&info, 0, sizeof(info));
        int result = waitid(P_PID, root, &info, WEXITED | WNOHANG | WNOWAIT);
        if (result == 0 && info.si_pid == root) break;
        if (result < 0 && errno != EINTR) { perror("waitid"); return 127; }
        if (stop_requested(argv[1])) kill(root, SIGKILL);
        usleep(1000);
    }
    if (kill(-root, SIGKILL) && errno != ESRCH)
        fprintf(stderr, "[process-run] WARNING: cannot kill group %d: %s\n", root, strerror(errno));
    /* Each killed parent reparents its children here, including detached sessions.
     * Keep root unreaped to prevent PID/group reuse while cleanup is in progress. */
    while (kill_owned(root)) {
        usleep(1000);
    }
    waitpid(root, &status, 0);
    return WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
}
