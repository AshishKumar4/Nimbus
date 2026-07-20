/* read all stdin, sort lines lexicographically, write out */
#include <unistd.h>
#include <stdlib.h>
#include <string.h>
static char buf[1<<20]; static char *lines[16384];
static int cmp(const void*a,const void*b){ return strcmp(*(char* const*)a,*(char* const*)b); }
int main(void){
  int len=0,n; while((n=read(0,buf+len,sizeof buf-1-len))>0) len+=n; buf[len]=0;
  int nl=0; char *p=buf;
  while(*p){ lines[nl++]=p; while(*p&&*p!='\n')p++; if(*p){*p=0;p++;} if(nl>=16384)break; }
  qsort(lines,nl,sizeof(char*),cmp);
  for(int i=0;i<nl;i++){ write(1,lines[i],strlen(lines[i])); write(1,"\n",1); }
  return 0;
}
