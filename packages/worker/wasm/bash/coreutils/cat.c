#include <unistd.h>
#include <fcntl.h>
static void copyfd(int fd){ char b[4096]; long n; while((n=read(fd,b,sizeof b))>0) write(1,b,n); }
int main(int argc, char **argv){
  if(argc<2){ copyfd(0); return 0; }
  int rc=0; for(int i=1;i<argc;i++){ int fd=open(argv[i],O_RDONLY); if(fd<0){rc=1;continue;} copyfd(fd); close(fd);} return rc;
}
