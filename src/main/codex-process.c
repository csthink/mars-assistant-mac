/* macOS child identity checks. No arguments, environment, or unrelated executable paths are read.
 * Commands:
 *   scan PID                 descendants of PID (parent links), one row per process
 *   check PID SEC USEC       "true" when PID still has that kernel start time
 *   stop PID SEC USEC        SIGKILL only when the start time matches
 *   term PID SEC USEC        SIGTERM only when the start time matches
 *   inspect PID              one process: identity tuple, session and the errno of each probe (never signals)
 */
#include <libproc.h>
#include <sys/proc_info.h>
#include <sys/proc.h>
#include <signal.h>
#include <unistd.h>
#include <stdlib.h>
#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include <errno.h>
struct row { pid_t pid; struct proc_bsdinfo info; int owned; };
static int info(pid_t pid, struct proc_bsdinfo *value) {
  return proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, value, sizeof(*value)) == sizeof(*value);
}
static void string(const char *text) {
  putchar('"');
  for(const unsigned char *p=(const unsigned char*)text;*p;p++) {
    if(*p=='"'||*p=='\\') {putchar('\\');putchar(*p);}
    else if(*p<32) printf("\\u%04x",*p);
    else putchar(*p);
  }
  putchar('"');
}
static int number(const char *s, uint64_t *value) {
  if(!s||!*s)return 0;char *end;errno=0;*value=strtoull(s,&end,10);
  return !errno&&!*end&&s[0]!='-';
}
static long session_of(pid_t pid) {
  errno=0; pid_t sid=getsid(pid); return sid<0?-1:(long)sid;
}
int main(int argc,char **argv) {
  uint64_t pid,sec,usec;
  if(argc<3||!number(argv[2],&pid)||pid<2||pid>INT32_MAX)return 2;
  if(!strcmp(argv[1],"check")||!strcmp(argv[1],"stop")||!strcmp(argv[1],"term")) {
    if(argc!=5||!number(argv[3],&sec)||!number(argv[4],&usec))return 2;
    struct proc_bsdinfo current;
    int matches=info((pid_t)pid,&current)&&current.pbi_start_tvsec==sec&&current.pbi_start_tvusec==usec;
    int sig=!strcmp(argv[1],"stop")?SIGKILL:!strcmp(argv[1],"term")?SIGTERM:0;
    if(sig&&matches&&kill((pid_t)pid,sig)<0&&errno!=ESRCH)return 3;
    puts(matches?"true":"false");return 0;
  }
  if(!strcmp(argv[1],"inspect")) {
    if(argc!=3)return 2;
    struct proc_bsdinfo p; memset(&p,0,sizeof(p)); char path[PROC_PIDPATHINFO_MAXSIZE]={0};
    errno=0; int size=proc_pidinfo((pid_t)pid,PROC_PIDTBSDINFO,0,&p,sizeof(p)); int ie=errno;
    errno=0; int plen=proc_pidpath((pid_t)pid,path,sizeof(path)); int pe=errno;
    errno=0; int alive=kill((pid_t)pid,0); int ke=errno;
    printf("{\"pid\":%llu,\"info_size\":%d,\"expected_size\":%zu,\"info_errno\":%d,\"path_size\":%d,\"path_errno\":%d,\"kill_result\":%d,\"kill_errno\":%d,\"uid\":%u,\"parent\":%u,\"group\":%u,\"session\":%ld,\"status\":%u,\"startSeconds\":%llu,\"startMicros\":%llu,\"path\":",
      (unsigned long long)pid,size,sizeof(p),ie,plen,pe,alive,ke,p.pbi_uid,p.pbi_ppid,p.pbi_pgid,session_of((pid_t)pid),p.pbi_status,(unsigned long long)p.pbi_start_tvsec,(unsigned long long)p.pbi_start_tvusec);
    string(path);puts("}");return 0;
  }
  if(strcmp(argv[1],"scan")||argc!=3)return 2;
  int count=proc_listallpids(NULL,0);if(count<=0)return 3;
  int capacity=count+2048;pid_t *pids=calloc((size_t)capacity,sizeof(pid_t));struct row *rows=calloc((size_t)capacity,sizeof(struct row));
  if(!pids||!rows)return 3;
  count=proc_listallpids(pids,capacity*(int)sizeof(pid_t));if(count<=0||count>=capacity)return 3;
  int size=0;
  for(int i=0;i<count;i++)if(pids[i]>1&&info(pids[i],&rows[size].info)){rows[size].pid=pids[i];rows[size].owned=pids[i]==(pid_t)pid;size++;}
  for(int pass=0;pass<size;pass++) {
    int changed=0;
    for(int i=0;i<size;i++)if(!rows[i].owned)for(int j=0;j<size;j++)if(rows[j].owned&&rows[i].info.pbi_ppid==(uint32_t)rows[j].pid){rows[i].owned=1;changed=1;break;}
    if(!changed)break;
  }
  putchar('[');int first=1;
  for(int i=0;i<size;i++)if(rows[i].owned){
    char path[PROC_PIDPATHINFO_MAXSIZE]={0};if(proc_pidpath(rows[i].pid,path,sizeof(path))<=0){struct proc_bsdinfo current;if(!info(rows[i].pid,&current)||current.pbi_status==SZOMB)continue;return 3;}
    if(!first)putchar(',');first=0;
    printf("{\"pid\":%d,\"parent\":%u,\"group\":%u,\"uid\":%u,\"session\":%ld,\"status\":%u,\"startSeconds\":%llu,\"startMicros\":%llu,\"path\":",rows[i].pid,rows[i].info.pbi_ppid,rows[i].info.pbi_pgid,rows[i].info.pbi_uid,session_of(rows[i].pid),rows[i].info.pbi_status,(unsigned long long)rows[i].info.pbi_start_tvsec,(unsigned long long)rows[i].info.pbi_start_tvusec);
    string(path);putchar('}');
  }
  puts("]");free(pids);free(rows);return 0;
}
