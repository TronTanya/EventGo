// QR version 3-L, byte mode, mask 0. Payload: EG: + 32 hex characters.
// No network services or third-party runtime dependencies.
export function qrMatrix(text) {
  const bytes=new TextEncoder().encode(text);
  if(bytes.length>53)throw new Error('Слишком длинный код билета.');
  const bits=[];const put=(value,n)=>{for(let i=n-1;i>=0;i--)bits.push((value>>>i)&1);};
  put(4,4);put(bytes.length,8);bytes.forEach(b=>put(b,8));
  for(let i=0,n=Math.min(4,440-bits.length);i<n;i++)bits.push(0);
  while(bits.length%8)bits.push(0);
  const data=[];for(let i=0;i<bits.length;i+=8)data.push(bits.slice(i,i+8).reduce((a,b)=>(a<<1)|b,0));
  for(let i=0;data.length<55;i++)data.push(i%2?0x11:0xec);
  const exp=new Array(512),log=new Array(256);let x=1;
  for(let i=0;i<255;i++){exp[i]=x;log[x]=i;x<<=1;if(x&256)x^=0x11d;}
  for(let i=255;i<512;i++)exp[i]=exp[i-255];
  const mul=(a,b)=>a&&b?exp[log[a]+log[b]]:0;
  let poly=[1];for(let i=0;i<15;i++){const next=new Array(poly.length+1).fill(0);poly.forEach((p,j)=>{next[j]^=p;next[j+1]^=mul(p,exp[i]);});poly=next;}
  const ecc=new Array(15).fill(0);for(const b of data){const factor=b^ecc.shift();ecc.push(0);for(let i=0;i<15;i++)ecc[i]^=mul(poly[i+1],factor);}
  const stream=[];[...data,...ecc].forEach(b=>{for(let i=7;i>=0;i--)stream.push((b>>>i)&1);});
  const size=29,m=Array.from({length:size},()=>Array(size).fill(null));
  function finder(row,col){for(let r=-1;r<=7;r++)for(let c=-1;c<=7;c++){const y=row+r,x=col+c;if(y<0||x<0||y>=size||x>=size)continue;m[y][x]=r>=0&&r<=6&&c>=0&&c<=6&&(r===0||r===6||c===0||c===6||(r>=2&&r<=4&&c>=2&&c<=4));}}
  finder(0,0);finder(0,size-7);finder(size-7,0);
  for(let r=-2;r<=2;r++)for(let c=-2;c<=2;c++)m[22+r][22+c]=Math.max(Math.abs(r),Math.abs(c))!==1;
  for(let i=8;i<size-8;i++){if(m[i][6]===null)m[i][6]=i%2===0;if(m[6][i]===null)m[6][i]=i%2===0;}
  const formatData=8;let rem=formatData<<10;const degree=n=>31-Math.clz32(n);while(degree(rem)>=10)rem^=0x537<<(degree(rem)-10);const format=((formatData<<10)|rem)^0x5412;
  for(let i=0;i<15;i++){const dark=((format>>>i)&1)===1;if(i<6)m[i][8]=dark;else if(i<8)m[i+1][8]=dark;else m[size-15+i][8]=dark;if(i<8)m[8][size-i-1]=dark;else if(i<9)m[8][15-i]=dark;else m[8][15-i-1]=dark;}
  m[size-8][8]=true;
  let index=0,row=size-1,direction=-1;
  for(let col=size-1;col>0;col-=2){if(col===6)col--;while(true){for(let c=0;c<2;c++)if(m[row][col-c]===null){let bit=index<stream.length?stream[index++]:0;if((row+col-c)%2===0)bit^=1;m[row][col-c]=!!bit;}row+=direction;if(row<0||row>=size){row-=direction;direction=-direction;break;}}}
  return m;
}
export function qrSvg(code){const m=qrMatrix(code),path=[];m.forEach((row,y)=>row.forEach((v,x)=>{if(v)path.push(`M${x+4} ${y+4}h1v1h-1z`);}));return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 37 37" role="img" aria-label="QR-код билета" shape-rendering="crispEdges"><rect width="37" height="37" fill="white"/><path d="${path.join('')}" fill="#17171f"/></svg>`;}
