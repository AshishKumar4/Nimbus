/* tr SET1 SET2 with a-z range expansion; translate stdin->stdout */
#include <unistd.h>
static int expand(const char *s, unsigned char *out){
  int n=0; for(int i=0; s[i]; ){
    if(s[i+1]=='-' && s[i+2]){ for(unsigned char c=s[i]; c<=(unsigned char)s[i+2]; c++) out[n++]=c; i+=3; }
    else out[n++]=(unsigned char)s[i++];
  }
  return n;
}
int main(int argc, char **argv){
  if(argc<3) return 1;
  unsigned char a[512], b[512]; int na=expand(argv[1],a), nb=expand(argv[2],b);
  unsigned char map[256]; for(int i=0;i<256;i++) map[i]=(unsigned char)i;
  for(int i=0;i<na && i<nb;i++) map[a[i]]=b[i];
  unsigned char buf[4096]; long n;
  while((n=read(0,buf,sizeof buf))>0){ for(long i=0;i<n;i++) buf[i]=map[buf[i]]; write(1,buf,n); }
  return 0;
}
