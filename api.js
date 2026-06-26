// ── Pure-JS PNG encoder — native CF Workers, không cần WASM ─────────────────
// Tạo PNG thật từ pixel data, bot decode base64 chỉ thấy binary PNG bytes

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function u32be(n) { return [(n>>>24)&0xFF,(n>>>16)&0xFF,(n>>>8)&0xFF,n&0xFF]; }
function pngChunk(type, data) {
  const t = [...type].map(c=>c.charCodeAt(0));
  const crc = u32be(crc32(new Uint8Array([...t,...data])));
  return [...u32be(data.length),...t,...data,...crc];
}
function deflateStore(data) {
  const out = [];
  let i = 0;
  while (i < data.length) {
    const sz = Math.min(65535, data.length - i);
    const last = (i+sz >= data.length) ? 1 : 0;
    out.push(last, sz&0xFF, (sz>>8)&0xFF, (~sz)&0xFF, (~sz>>8)&0xFF);
    for (let j=0;j<sz;j++) out.push(data[i+j]);
    i += sz;
  }
  let s1=1, s2=0;
  for (const b of data) { s1=(s1+b)%65521; s2=(s2+s1)%65521; }
  return [0x78,0x01,...out,(s2>>8)&0xFF,s2&0xFF,(s1>>8)&0xFF,s1&0xFF];
}
function buildPng(pixels, w, h) {
  // pixels: Uint8Array RGBA, w*h*4 bytes
  const raw = [];
  for (let y=0;y<h;y++) {
    raw.push(0); // filter None
    for (let x=0;x<w;x++) {
      const i=(y*w+x)*4;
      raw.push(pixels[i],pixels[i+1],pixels[i+2]); // RGB only
    }
  }
  const sig = [137,80,78,71,13,10,26,10];
  const ihdr = pngChunk("IHDR",[...u32be(w),...u32be(h),8,2,0,0,0]);
  const idat = pngChunk("IDAT",deflateStore(raw));
  const iend = pngChunk("IEND",[]);
  return new Uint8Array([...sig,...ihdr,...idat,...iend]);
}

// Vẽ pixel canvas đơn giản trong JS
class Canvas {
  constructor(w, h) {
    this.w = w; this.h = h;
    this.buf = new Uint8Array(w * h * 4); // RGBA
    this.buf.fill(0);
  }
  _set(x, y, r, g, b, a=255) {
    x=Math.round(x); y=Math.round(y);
    if (x<0||x>=this.w||y<0||y>=this.h) return;
    const i=(y*this.w+x)*4;
    // Alpha blend
    const aa=a/255, ia=1-aa;
    this.buf[i]   = this.buf[i]*ia   + r*aa;
    this.buf[i+1] = this.buf[i+1]*ia + g*aa;
    this.buf[i+2] = this.buf[i+2]*ia + b*aa;
    this.buf[i+3] = 255;
  }
  fill(r,g,b) { for(let y=0;y<this.h;y++) for(let x=0;x<this.w;x++) this._set(x,y,r,g,b); }
  rect(x,y,w,h,r,g,b,a=255) {
    for(let dy=0;dy<h;dy++) for(let dx=0;dx<w;dx++) this._set(x+dx,y+dy,r,g,b,a);
  }
  // Bresenham line
  line(x0,y0,x1,y1,r,g,b,a=255,thick=1) {
    x0=Math.round(x0);y0=Math.round(y0);x1=Math.round(x1);y1=Math.round(y1);
    const dx=Math.abs(x1-x0),dy=Math.abs(y1-y0);
    const sx=x0<x1?1:-1,sy=y0<y1?1:-1;
    let err=dx-dy;
    while(true) {
      for(let t=0;t<thick;t++) for(let u=0;u<thick;u++) this._set(x0+t,y0+u,r,g,b,a);
      if(x0===x1&&y0===y1) break;
      const e2=2*err;
      if(e2>-dy){err-=dy;x0+=sx;}
      if(e2<dx){err+=dx;y0+=sy;}
    }
  }
  // Midpoint circle
  circle(cx,cy,rad,r,g,b,a=255,fill=false) {
    cx=Math.round(cx);cy=Math.round(cy);
    if(fill) {
      for(let dy=-rad;dy<=rad;dy++)
        for(let dx=-rad;dx<=rad;dx++)
          if(dx*dx+dy*dy<=rad*rad) this._set(cx+dx,cy+dy,r,g,b,a);
    } else {
      let x=rad,y=0,err=0;
      while(x>=y){
        for(const [px,py] of [[x,y],[-x,y],[x,-y],[-x,-y],[y,x],[-y,x],[y,-x],[-y,-x]])
          this._set(cx+px,cy+py,r,g,b,a);
        y++;err+=2*y-1;if(2*(err-x)+1>0){x--;err+=1-2*x;}
      }
    }
  }
  // Noise dots
  noise(count, ri) {
    for(let i=0;i<count;i++) {
      const x=ri(0,this.w-1),y=ri(0,this.h-1);
      const v=ri(120,255);
      this._set(x,y,v,v,v,ri(30,90));
    }
  }
  toPng() { return buildPng(this.buf,this.w,this.h); }
  toBase64() {
    const png=this.toPng();
    let bin='';
    for(let i=0;i<png.length;i+=8192) bin+=String.fromCharCode(...png.subarray(i,i+8192));
    return btoa(bin);
  }
}

// Bitmap font 5×7 cho chữ số + chữ hoa — encode mỗi char là 5 cột uint8
const FONT5X7 = {
  'A':[[0x1E,0x05,0x05,0x1E,0x00]],
  'B':[[0x1F,0x15,0x15,0x0A,0x00]],
  'C':[[0x0E,0x11,0x11,0x11,0x00]],
  'D':[[0x1F,0x11,0x11,0x0E,0x00]],
  'E':[[0x1F,0x15,0x15,0x11,0x00]],
  'F':[[0x1F,0x05,0x05,0x01,0x00]],
  'G':[[0x0E,0x11,0x15,0x1D,0x00]],
  'H':[[0x1F,0x04,0x04,0x1F,0x00]],
  'J':[[0x08,0x10,0x11,0x0F,0x00]],
  'K':[[0x1F,0x04,0x0A,0x11,0x00]],
  'L':[[0x1F,0x10,0x10,0x10,0x00]],
  'M':[[0x1F,0x02,0x04,0x02,0x1F]],
  'N':[[0x1F,0x02,0x04,0x08,0x1F]],
  'P':[[0x1F,0x05,0x05,0x02,0x00]],
  'Q':[[0x0E,0x11,0x19,0x0E,0x10]],
  'R':[[0x1F,0x05,0x0D,0x12,0x00]],
  'S':[[0x12,0x15,0x15,0x09,0x00]],
  'T':[[0x01,0x01,0x1F,0x01,0x01]],
  'U':[[0x0F,0x10,0x10,0x0F,0x00]],
  'V':[[0x07,0x08,0x10,0x08,0x07]],
  'W':[[0x1F,0x08,0x04,0x08,0x1F]],
  'X':[[0x11,0x0A,0x04,0x0A,0x11]],
  'Y':[[0x03,0x04,0x18,0x04,0x03]],
  'Z':[[0x19,0x15,0x15,0x13,0x00]],
  '0':[[0x0E,0x13,0x15,0x19,0x0E]],
  '1':[[0x00,0x04,0x1F,0x00,0x00]],
  '2':[[0x19,0x15,0x15,0x12,0x00]],
  '3':[[0x11,0x15,0x15,0x0A,0x00]],
  '4':[[0x07,0x04,0x1F,0x04,0x00]],
  '5':[[0x17,0x15,0x15,0x09,0x00]],
  '6':[[0x0E,0x15,0x15,0x08,0x00]],
  '7':[[0x01,0x19,0x05,0x03,0x00]],
  '8':[[0x0A,0x15,0x15,0x0A,0x00]],
  '9':[[0x02,0x15,0x15,0x0E,0x00]],
  '+':[[0x04,0x04,0x1F,0x04,0x04]],
  '-':[[0x04,0x04,0x04,0x04,0x04]],
  '×':[[0x11,0x0A,0x04,0x0A,0x11]],
  '÷':[[0x04,0x15,0x0E,0x15,0x04]],
  '=':[[0x0A,0x0A,0x0A,0x0A,0x00]],
  '?':[[0x02,0x01,0x15,0x03,0x00]],
  ' ':[[0x00,0x00,0x00,0x00,0x00]],
};

function drawChar(canvas, ch, x, y, r, g, b, scale=4, rot=0) {
  const cols = (FONT5X7[ch] || FONT5X7['?'])[0];
  const cx = x + (5*scale)/2, cy = y + (7*scale)/2;
  const cos = Math.cos(rot*Math.PI/180), sin = Math.sin(rot*Math.PI/180);
  for (let col=0; col<5; col++) {
    for (let row=0; row<7; row++) {
      if (cols[col] & (1<<row)) {
        for(let sy=0;sy<scale;sy++) for(let sx=0;sx<scale;sx++) {
          const px=x+col*scale+sx-cx, py=y+row*scale+sy-cy;
          const rx=px*cos-py*sin+cx, ry=px*sin+py*cos+cy;
          canvas._set(Math.round(rx),Math.round(ry),r,g,b,230);
        }
      }
    }
  }
}

function drawText(canvas, text, x, y, r, g, b, scale=4, ri) {
  let cx = x;
  for (const ch of text) {
    const rot = ri ? ri(-18,18) : 0;
    const dy  = ri ? ri(-4,4) : 0;
    drawChar(canvas, ch, cx, y+dy, r, g, b, scale, rot);
    cx += 6*scale + (ri ? ri(-2,3) : 2);
  }
}

// Render text captcha → PNG base64
function renderTextCaptchaPng(answer, ri) {
  const c = new Canvas(200, 60);
  c.fill(10,14,26);
  c.noise(200, ri);
  // Lines nhiễu
  for(let i=0;i<5;i++) c.line(ri(0,200),ri(0,60),ri(0,200),ri(0,60),ri(80,180),ri(80,180),ri(80,180),ri(30,70));
  // Vẽ từng chữ với màu + xoay ngẫu nhiên
  const COLS = [[0,229,255],[6,255,165],[196,181,253],[251,191,36],[248,113,113],[52,211,153]];
  answer.split('').forEach((ch,i) => {
    const [r,g,b] = COLS[i % COLS.length];
    drawChar(c, ch, 18+i*34+ri(-3,3), 10+ri(-5,5), r,g,b, ri(3,4), ri(-20,20));
  });
  c.noise(80, ri);
  return c.toBase64();
}

// Render shape tile → PNG base64
// Helper: scanline fill polygon
function fillPoly(canvas, pts, r, g, b, a) {
  const minY=Math.floor(Math.min(...pts.map(p=>p[1])));
  const maxY=Math.ceil(Math.max(...pts.map(p=>p[1])));
  for(let y=minY;y<=maxY;y++){
    const xs=[];
    for(let i=0;i<pts.length;i++){
      const [ax,ay]=pts[i],[bx,by]=pts[(i+1)%pts.length];
      if((ay<=y&&y<by)||(by<=y&&y<ay)) xs.push(ax+(bx-ax)*(y-ay)/(by-ay));
    }
    if(xs.length>=2){xs.sort((a,b2)=>a-b2);for(let x=Math.round(xs[0]);x<=Math.round(xs[xs.length-1]);x++) canvas._set(x,y,r,g,b,a);}
  }
}

// Vẽ 1 shape (có thể xoay) lên canvas tại vị trí cx,cy, size s
function drawShapeOnCanvas(canvas, shape, cx, cy, s, r, g, b, a, rotDeg) {
  const rot = (rotDeg||0) * Math.PI/180;
  const rotate = (px,py) => [
    cx + (px-cx)*Math.cos(rot) - (py-cy)*Math.sin(rot),
    cy + (px-cx)*Math.sin(rot) + (py-cy)*Math.cos(rot)
  ];
  if (shape==='circle') {
    canvas.circle(cx,cy,s,r,g,b,a,true);
  } else if (shape==='square') {
    const corners=[[-s,-s],[s,-s],[s,s],[-s,s]].map(([dx,dy])=>rotate(cx+dx,cy+dy));
    fillPoly(canvas,corners,r,g,b,a);
  } else if (shape==='triangle') {
    const pts=[[cx,cy-s],[cx-s,cy+s],[cx+s,cy+s]].map(([px,py])=>rotate(px,py));
    fillPoly(canvas,pts,r,g,b,a);
  } else if (shape==='star') {
    const pts=[];
    for(let i=0;i<10;i++){
      const angle=(i*Math.PI/5)-Math.PI/2+rot;
      const rad=(i%2===0)?s:s/2.5;
      pts.push([cx+rad*Math.cos(angle),cy+rad*Math.sin(angle)]);
    }
    fillPoly(canvas,pts,r,g,b,a);
  }
}

function renderShapePng(shape, colorHex, ri) {
  // Vẽ vào buffer tạm lớn hơn rồi warp về 80x80
  const W=80, H=80;
  const tmp = new Canvas(W, H);
  tmp.fill(10,14,26);

  // ── Shape chính ──
  const hex = colorHex.replace('#','');
  const r=parseInt(hex.slice(0,2),16),g=parseInt(hex.slice(2,4),16),b=parseInt(hex.slice(4,6),16);
  const cx=ri(28,52), cy=ri(28,52), s=ri(14,20);
  const rot=ri(0,359);
  drawShapeOnCanvas(tmp,shape,cx,cy,s,r,g,b,ri(210,250),rot);

  // ── Noise dots nhẹ trước warp ──
  tmp.noise(30, ri);

  // ── Warp: sine nhẹ + rotate nhẹ (~30 độ) ──
  const out = new Canvas(W, H);
  out.fill(10,14,26);

  // Sine displacement nhẹ
  const ampX  = ri(1, 2);
  const ampY  = ri(1, 2);
  const freqX = ri(8, 12) / 100;
  const freqY = ri(8, 12) / 100;
  const phX   = ri(0, 628) / 100;
  const phY   = ri(0, 628) / 100;

  // Rotate toàn ảnh nhẹ (-15 ~ +15 độ) quanh tâm
  const rotDeg = ri(-15, 15);
  const rotRad = rotDeg * Math.PI / 180;
  const cosR = Math.cos(rotRad), sinR = Math.sin(rotRad);
  const midX = W/2, midY = H/2;

  for(let y=0;y<H;y++){
    for(let x=0;x<W;x++){
      // 1. Undo rotate để tìm nguồn
      const dx = x - midX, dy = y - midY;
      const ux =  dx*cosR + dy*sinR + midX;
      const uy = -dx*sinR + dy*cosR + midY;
      // 2. Thêm sine displacement nhẹ
      const srcX = ux + ampX * Math.sin(freqY * uy + phY);
      const srcY = uy + ampY * Math.sin(freqX * ux + phX);
      const sx = Math.round(srcX), sy = Math.round(srcY);
      if(sx>=0&&sx<W&&sy>=0&&sy<H){
        const si=(sy*W+sx)*4;
        out._set(x,y, tmp.buf[si],tmp.buf[si+1],tmp.buf[si+2], tmp.buf[si+3]);
      }
    }
  }

  // ── Noise lines đè sau warp ──
  for(let i=0;i<ri(3,5);i++){
    const lv=ri(50,110);
    out.line(ri(0,80),ri(0,80),ri(0,80),ri(0,80),lv,lv,lv,ri(35,65));
  }
  // ── Noise dots sau warp ──
  out.noise(ri(50,80), ri);

  return out.toBase64();
}

// Render blocks captcha → PNG base64
function renderBlocksPng(heights, colCount, ri) {
  const colW=54, blockH=22, blockW=34, padX=8, maxH=7;
  const svgW=colCount*colW+padX*2, svgH=maxH*blockH+44;
  const c = new Canvas(svgW, svgH);
  c.fill(10,14,26);
  c.noise(60, ri);
  const COLS=['#00e5ff','#06ffa5','#c4b5fd','#fbbf24','#f87171','#34d399','#f472b6'];
  for(let col=0;col<colCount;col++){
    const cx=padX+col*colW+colW/2;
    const hex=COLS[col%COLS.length].replace('#','');
    const r=parseInt(hex.slice(0,2),16),g=parseInt(hex.slice(2,4),16),b=parseInt(hex.slice(4,6),16);
    // Góc nghiêng ngẫu nhiên cho cả cột (-15 ~ +15 độ)
    const tiltDeg = ri(-20, 20);
    const tiltRad = tiltDeg * Math.PI / 180;
    const cosT = Math.cos(tiltRad), sinT = Math.sin(tiltRad);
    // Gốc xoay là đáy cột
    const baseY = svgH - 28;
    const rotatePt = (px, py) => { const dx=px-cx, dy=py-baseY; return [
        cx + dx*cosT - dy*sinT,
        baseY + dx*sinT + dy*cosT
      ]; };

    for(let h=0;h<heights[col];h++){
      const by=svgH-28-(h+1)*blockH+2;
      const bx=cx-blockW/2+ri(-2,2);
      // 4 góc của block, xoay theo tilt
      const corners = [
        rotatePt(bx, by),
        rotatePt(bx+blockW, by),
        rotatePt(bx+blockW, by+blockH-3),
        rotatePt(bx, by+blockH-3),
      ];
      fillPoly(c, corners, r, g, b, 200);
      // highlight top
      const hl = [
        rotatePt(bx+2, by+1),
        rotatePt(bx+blockW-2, by+1),
        rotatePt(bx+blockW-2, by+3),
        rotatePt(bx+2, by+3),
      ];
      fillPoly(c, hl, 255, 255, 255, 40);
    }
    // label số cột
    const lbl=String(col+1);
    drawText(c,lbl,cx-4,svgH-20,100,100,140,1,null);
  }
  return c.toBase64();
}




// ════════════════════════════════════════════════════════════════════════
// HIGH CAPTCHA — Loại 1: Phân mảnh (đếm hình theo màu)
// ════════════════════════════════════════════════════════════════════════
function renderFragmentPng(objects, ri) {
  const W = 320, H = 200;
  const c = new Canvas(W, H);
  c.fill(8, 10, 22);
  // Nhiễu nền nhẹ
  c.noise(80, ri);
  const SLASH_COLS = [
    [220,60,60],[60,180,220],[220,180,60],[160,80,220],
    [60,220,140],[220,120,60],[180,220,80],[80,120,220],
  ];
  // Dấu \\ trước hình — full height, random màu, mờ vừa
  for (let i = 0; i < 8; i++) {
    const x1 = ri(-20, W+20), x2 = x1 + ri(30, 70);
    const sc = SLASH_COLS[ri(0, SLASH_COLS.length-1)];
    c.line(x1, -5, x2, H+5, sc[0], sc[1], sc[2], ri(40, 75), 1);
  }

  for (const obj of objects) {
    const { shape, color, x, y, size, rot } = obj;
    const [r, g, b] = color;
    const rotRad = rot * Math.PI / 180;

    // Viền trắng mỏng quanh hình (vẽ trước, to hơn 2px)
    const wb = 2;
    if (shape === 'square') {
      const makePts = (s) => [[-s,-s],[s,-s],[s,s],[-s,s]].map(([dx,dy]) => [
        x + dx*Math.cos(rotRad) - dy*Math.sin(rotRad),
        y + dx*Math.sin(rotRad) + dy*Math.cos(rotRad),
      ]);
      fillPoly(c, makePts(size+wb), 200, 200, 200, 120);
      fillPoly(c, makePts(size), r, g, b, 240);
    } else if (shape === 'circle') {
      c.circle(x, y, size+wb, 200, 200, 200, 120, true);
      c.circle(x, y, size, r, g, b, 240, true);
    } else if (shape === 'star') {
      const makeStar = (s) => {
        const pts = [];
        for (let i = 0; i < 10; i++) {
          const angle = (i*Math.PI/5) - Math.PI/2 + rotRad;
          const rad = (i%2===0) ? s : s/2.2;
          pts.push([x+rad*Math.cos(angle), y+rad*Math.sin(angle)]);
        }
        return pts;
      };
      fillPoly(c, makeStar(size+wb), 200, 200, 200, 120);
      fillPoly(c, makeStar(size), r, g, b, 240);
    } else if (shape === 'triangle') {
      const makeTri = (s) => [0,2.094,4.189].map(off => [
        x + s*Math.cos(-Math.PI/2 + rotRad + off),
        y + s*Math.sin(-Math.PI/2 + rotRad + off),
      ]);
      fillPoly(c, makeTri(size+wb), 200, 200, 200, 120);
      fillPoly(c, makeTri(size), r, g, b, 240);
    }
  }

  // Dấu \\ và _ đè LÊN sau khi vẽ hình — random màu
  for (let i = 0; i < 8; i++) {
    const x1 = ri(-20, W+20), x2 = x1 + ri(30, 70);
    const sc = SLASH_COLS[ri(0, SLASH_COLS.length-1)];
    c.line(x1, -5, x2, H+5, sc[0], sc[1], sc[2], ri(55, 90), 2);
  }
  // Dấu _ ngang — random Y, full width
  for (let i = 0; i < 6; i++) {
    const y1 = ri(0, H), y2 = y1 + ri(-8, 8);
    const sc = SLASH_COLS[ri(0, SLASH_COLS.length-1)];
    c.line(-5, y1, W+5, y2, sc[0], sc[1], sc[2], ri(45, 80), 2);
  }

  c.noise(25, ri);
  return c.toBase64();
}

// ════════════════════════════════════════════════════════════════════════
// HIGH CAPTCHA — Loại 2: Chuỗi loạn (nhập ký tự thứ N)
// targetIndices: mảng 3-4 vị trí cần nhập
// ════════════════════════════════════════════════════════════════════════
function renderChaosPng(chars, targetIndices, ri) {
  const n = chars.length;
  const SCALE = 4;
  const CHAR_W = 5*SCALE + 14;
  const PAD = 14;
  const W = PAD*2 + n*CHAR_W;
  const H = 130;
  const c = new Canvas(W, H);
  c.fill(8, 10, 22);

  // Nhiễu nền
  c.noise(160, ri);

  const COLS = [
    [248,113,113],[251,191,36],[52,211,153],[196,181,253],
    [0,229,255],[248,180,90],[167,243,208],[249,115,22],
    [240,100,150],[100,220,180],[200,160,80],[130,180,240],
  ];

  // Tạo vị trí X random cho từng ký tự — không đều nhau
  // Chia canvas thành n slot nhưng random trong mỗi slot để không đè nhau
  const slotW = Math.floor((W - PAD*2) / n);
  const positions = Array.from({length: n}, (_, i) => ({
    x: PAD + i * slotW + ri(2, slotW - 5*SCALE - 4),
    y: ri(6, H - 32 - 7*SCALE),
    rot: ri(-28, 28),
  }));

  // ── 1. Vẽ ký tự + số TRƯỚC ──
  positions.forEach(({x, y, rot}, i) => {
    const ch = chars[i];
    const [r, g, b] = COLS[i % COLS.length];

    // Shadow tối
    drawChar(c, ch, x+2, y+2, 10, 10, 20, SCALE, rot+ri(-6,6));
    // Ký tự chính
    drawChar(c, ch, x, y, r, g, b, SCALE, rot);

  });

  // Shuffle displayNums — số hiển thị random thứ tự
  const displayNums = Array.from({length: n}, (_,i) => i+1).sort(() => Math.random()-0.5);

  // Vẽ lại số với displayNums đã shuffle
  positions.forEach(({x, y}, i) => {
    const numStr = String(displayNums[i]);
    const numX = x + ri(-2, 2);
    const numY = y + 7*SCALE + 4;
    drawChar(c, numStr, numX+1, numY+1, 5, 5, 15, 2, 0);
    drawChar(c, numStr, numX, numY, 220, 230, 255, 2, 0);
  });

  const SLASH_COLS = [
    [220,60,60],[60,180,220],[220,180,60],[160,80,220],
    [60,220,140],[220,120,60],[180,220,80],[80,120,220],
  ];
  // ── 2. Dấu \\ và _ ĐÈ lên ký tự — random màu ──
  for (let i = 0; i < 14; i++) {
    const x1 = ri(-20, W+20), x2 = x1 + ri(30, 70);
    const sc = SLASH_COLS[ri(0, SLASH_COLS.length-1)];
    c.line(x1, -5, x2, H+5, sc[0], sc[1], sc[2], ri(90, 150), 2);
  }
  // Dấu _ ngang full width — random Y
  for (let i = 0; i < 5; i++) {
    const y1 = ri(4, H-4), y2 = y1 + ri(-6, 6);
    const sc = SLASH_COLS[ri(0, SLASH_COLS.length-1)];
    c.line(-5, y1, W+5, y2, sc[0], sc[1], sc[2], ri(80, 130), 2);
  }

  c.noise(50, ri);
  return { image: c.toBase64(), displayNums };
}


// ════════════════════════════════════════════════════════════════════════
// Localisation — detect country → language → translate prompt
// ════════════════════════════════════════════════════════════════════════
const LANG_MAP = {
  VN: 'vi', // Vietnam
  TH: 'th', // Thailand
  ID: 'id', // Indonesia
  JP: 'ja', // Japan
  KR: 'ko', // Korea
  CN: 'zh', // China
  TW: 'zh',
  HK: 'zh',
  FR: 'fr', // France
  DE: 'de', // Germany
  ES: 'es', // Spain
  PT: 'pt', // Portugal/Brazil
  BR: 'pt',
  RU: 'ru', // Russia
  TR: 'tr', // Turkey
  AR: 'ar', // Saudi Arabia
  SA: 'ar',
  EG: 'ar',
};

const T = {
  // shapes
  select_all: {
    en: 'Select all', vi: 'Chọn tất cả', th: 'เลือกทั้งหมด', id: 'Pilih semua',
    ja: 'すべて選択', ko: '모두 선택', zh: '选择全部', fr: 'Sélectionner tout',
    de: 'Alle auswählen', es: 'Seleccionar todo', pt: 'Selecionar tudo',
    ru: 'Выбрать все', tr: 'Hepsini seç', ar: 'اختر الكل',
  },
  circles:   { en:'circles',   vi:'hình tròn',   th:'วงกลม',    id:'lingkaran', ja:'丸',     ko:'원',    zh:'圆形', fr:'cercles',   de:'Kreise',    es:'círculos',   pt:'círculos',   ru:'круги',      tr:'daireler', ar:'دوائر'   },
  squares:   { en:'squares',   vi:'hình vuông',  th:'สี่เหลี่ยม', id:'kotak',    ja:'四角',   ko:'사각형', zh:'方形', fr:'carrés',    de:'Quadrate',  es:'cuadrados',  pt:'quadrados',  ru:'квадраты',   tr:'kareler',  ar:'مربعات'  },
  triangles: { en:'triangles', vi:'tam giác',    th:'สามเหลี่ยม', id:'segitiga', ja:'三角',   ko:'삼각형', zh:'三角', fr:'triangles', de:'Dreiecke',  es:'triángulos', pt:'triângulos', ru:'треугольники',tr:'üçgenler', ar:'مثلثات'  },
  stars:     { en:'stars',     vi:'ngôi sao',    th:'ดาว',      id:'bintang',   ja:'星',     ko:'별',    zh:'星形', fr:'étoiles',   de:'Sterne',    es:'estrellas',  pt:'estrelas',   ru:'звёзды',     tr:'yıldızlar',ar:'نجوم'     },
  // blocks
  select_col: {
    en: 'Select the column with', vi: 'Chọn cột có', th: 'เลือกคอลัมน์ที่มี',
    id: 'Pilih kolom dengan', ja: '次のブロック数の列を選択', ko: '다음 블록이 있는 열 선택',
    zh: '选择有', fr: 'Sélectionner la colonne avec', de: 'Spalte auswählen mit',
    es: 'Seleccionar la columna con', pt: 'Selecionar a coluna com',
    ru: 'Выберите столбец с', tr: 'Şu kadar bloğu olan sütunu seçin:', ar: 'اختر العمود الذي يحتوي على',
  },
  block: { en:'block', vi:'khối', th:'บล็อก', id:'blok', ja:'ブロック', ko:'블록', zh:'块', fr:'bloc', de:'Block', es:'bloque', pt:'bloco', ru:'блок', tr:'blok', ar:'مكعب' },
  blocks: { en:'blocks', vi:'khối', th:'บล็อก', id:'blok', ja:'ブロック', ko:'블록', zh:'块', fr:'blocs', de:'Blöcke', es:'bloques', pt:'blocos', ru:'блоков', tr:'blok', ar:'مكعبات' },
  stacked: { en:'stacked', vi:'chồng lên', th:'ซ้อนกัน', id:'ditumpuk', ja:'積み重なった', ko:'쌓인', zh:'堆叠', fr:'empilés', de:'gestapelt', es:'apilados', pt:'empilhados', ru:'сложены', tr:'istiflenmiş', ar:'مكدسة' },
  // fragment
  how_many: { en:'How many', vi:'Có bao nhiêu', th:'มีกี่', id:'Berapa banyak', ja:'いくつの', ko:'몇 개의', zh:'有几个', fr:'Combien de', de:'Wie viele', es:'¿Cuántos', pt:'Quantos', ru:'Сколько', tr:'Kaç tane', ar:'كم عدد' },
  are_there: { en:'are there?', vi:'trong ảnh?', th:'ในภาพ?', id:'ada?', ja:'ありますか?', ko:'있나요?', zh:'?', fr:'y a-t-il?', de:'gibt es?', es:'hay?', pt:'há?', ru:'на картинке?', tr:'var?', ar:'يوجد؟' },
  // colors
  red:    { en:'red',    vi:'đỏ',    th:'แดง',  id:'merah',  ja:'赤',  ko:'빨간', zh:'红色', fr:'rouge',  de:'rote',   es:'rojo',   pt:'vermelho', ru:'красных', tr:'kırmızı', ar:'الحمراء'  },
  blue:   { en:'blue',   vi:'xanh',  th:'น้ำเงิน',id:'biru',  ja:'青',  ko:'파란', zh:'蓝色', fr:'bleu',   de:'blaue',  es:'azul',   pt:'azul',     ru:'синих',   tr:'mavi',    ar:'الزرقاء'  },
  yellow: { en:'yellow', vi:'vàng',  th:'เหลือง',id:'kuning', ja:'黄',  ko:'노란', zh:'黄色', fr:'jaune',  de:'gelbe',  es:'amarillo',pt:'amarelo',  ru:'жёлтых',  tr:'sarı',    ar:'الصفراء'  },
  purple: { en:'purple', vi:'tím',   th:'ม่วง',  id:'ungu',   ja:'紫',  ko:'보라', zh:'紫色', fr:'violet', de:'lila',   es:'morado',  pt:'roxo',     ru:'фиолетовых',tr:'mor',   ar:'البنفسجية'},
  // chaos
  enter_chars: {
    en: 'Enter characters at positions', vi: 'Nhập ký tự tại vị trí',
    th: 'พิมพ์ตัวอักษรที่ตำแหน่ง', id: 'Masukkan karakter di posisi',
    ja: '次の位置の文字を入力してください', ko: '다음 위치의 문자를 입력하세요',
    zh: '输入以下位置的字符', fr: 'Entrez les caractères aux positions',
    de: 'Zeichen an Positionen eingeben', es: 'Ingrese caracteres en las posiciones',
    pt: 'Digite os caracteres nas posições', ru: 'Введите символы на позициях',
    tr: 'Şu konumlardaki karakterleri girin', ar: 'أدخل الأحرف في المواضع',
  },
};

function getLang(request) {
  const country = (request.headers.get('CF-IPCountry') || 'US').toUpperCase();
  return LANG_MAP[country] || 'en';
}

function t(key, lang, fallback='en') {
  return (T[key] && (T[key][lang] || T[key][fallback])) || key;
}

const SESSION_TTL = 2 * 60 * 60;
const IP_WINDOW   = 24 * 60 * 60;
const IP_MAX_HWID = 20;

const ALLOWED_ORIGINS = [
  "https://ntt-hub.xyz",
  "https://www.ntt-hub.xyz",
  "https://ntt-system.pages.dev",
  "https://ntt-system.xyz",
  "https://www.ntt-system.xyz",
  "https://nttsy.xyz",
  "https://www.nttsy.xyz",
  "null",
];


function getCors(request) {
  const origin  = request?.headers?.get("Origin") || "";
  const allowed = (!origin || ALLOWED_ORIGINS.includes(origin)) ? (origin || "*") : "https://ntt-hub.xyz";
  return {
    "Access-Control-Allow-Origin":  allowed,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, User-Agent, Authorization",
    "Vary": "Origin",
  };
}

function json(obj, status = 200, request = null) {
  if (status && typeof status === "object" && status.headers) {
    request = status;
    status  = 200;
  }
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...getCors(request), "Content-Type": "application/json" },
  });
}

function text(str, status = 200, request = null) {
  return new Response(str, {
    status,
    headers: { ...getCors(request), "Content-Type": "text/plain" },
  });
}

function normalizeHwid(url) {
  const raw = url.search.match(/[?&]hwid=([^&]*)/)?.[1];
  if (!raw) return null;
  try {
    const decoded = decodeURIComponent(raw).replace(/ /g, "+");
    return decoded.length > 200 ? null : decoded;
  } catch {
    const h = raw.replace(/ /g, "+");
    return h.length > 200 ? null : h;
  }
}

async function checkLinkvertiseHash(hash, token, userAgent) {
  const apiUrl = `https://publisher.linkvertise.com/api/v1/anti_bypassing?token=${token}&hash=${encodeURIComponent(hash)}`;
  try {
    const res  = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": userAgent || "Cloudflare-Worker" },
    });
    const data = await res.json();
    return data?.status === true;
  } catch { return false; }
}

function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 131 + str.charCodeAt(i)) % 4294967296;
  }
  return hash;
}

function toHex(str) {
  return [...str].map(c =>
    c.charCodeAt(0).toString(16).padStart(2, "0").toUpperCase()
  ).join("");
}

function encodeData(plaintext, baseKey) {
  const t = Math.floor(Date.now() / 1000);
  const rawKey    = String(baseKey) + ":" + String(t);
  const hashedKey = simpleHash(rawKey);

  const result = [];
  for (let i = 0; i < plaintext.length; i++) {
    const byte = plaintext.charCodeAt(i);
    const k    = (hashedKey + (i + 1) * 7) % 256;
    let encoded = (byte ^ k);
    encoded = (encoded + k) % 256;
    result.push(String.fromCharCode(encoded));
  }

  const encodedStr  = toHex(result.join(""));
  const timeEncoded = Math.floor(simpleHash(String(t) + "salt")).toString();
  return timeEncoded + "|" + t + "|" + encodedStr;
}

async function sendWebhook(webhookUrl, { hwid, key, hwidsToday, flowKey, flowName }) {
  if (!webhookUrl) return;
  const flowLabel = flowName ? `${flowName} (ID: ${flowKey})` : flowKey === "default" ? "Default" : `Flow ${flowKey}`;
  const embed = {
    title: "New Key Generated",
    color: 0x00ff9d,
    fields: [
      { name: "HWID",  value: `${hwid}`, inline: false },
      { name: "Key",   value: `${key}`,  inline: false },
      { name: "Flow",  value: flowLabel,      inline: true },
      { name: "HWIDs Today (this IP)", value: `${hwidsToday}`, inline: true },
    ],
    footer: { text: "NTT System" },
    timestamp: new Date().toISOString(),
  };
  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [embed] }),
    });
  } catch {}
}

const JWT_SECRET = "ntt-hub-jwt-secret-change-this";
const SESSION_DURATION = 7 * 24 * 60 * 60;

async function hashPassword(password) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password + "ntt-salt-key");
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

async function generateToken(userId, username) {
  const header  = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = btoa(JSON.stringify({
    userId,
    username,
    exp: Math.floor(Date.now() / 1000) + SESSION_DURATION,
  }));
  const signature = await hashPassword(header + "." + payload + JWT_SECRET);
  return `${header}.${payload}.${signature.substring(0, 43)}`;
}

async function verifyToken(token) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = JSON.parse(atob(parts[1]));
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    const expectedSig = await hashPassword(parts[0] + "." + parts[1] + JWT_SECRET);
    if (!expectedSig.startsWith(parts[2])) return null;
    return payload;
  } catch {
    return null;
  }
}

async function requireAuthUser(request, userId) {
  const authHeader = request.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return { response: json({ success: false, error: "Unauthorized" }, 401, request) };
  const authPayload = await verifyToken(authHeader.slice(7));
  if (!authPayload) return { response: json({ success: false, error: "Invalid or expired token" }, 401, request) };
  if (String(authPayload.userId) !== String(userId)) return { response: json({ success: false, error: "Forbidden" }, 403, request) };
  return { payload: authPayload };
}

const VALID_KEY_DURATIONS = [7200, 21600, 43200, 86400, 172800];
function safeKeyDuration(v) {
  const n = Number(v);
  return VALID_KEY_DURATIONS.includes(n) ? n : 86400;
}

const MAX_FLOW_STEPS = 8;
function clampAdSteps(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(MAX_FLOW_STEPS, Math.floor(n)));
}
function stepValue(obj, n, field, fallback = '') {
  return obj?.[`step${n}_${field}`] ?? fallback;
}
function stepTypeValue(obj, n) {
  return stepValue(obj, n, 'type', 'linkvertise') || 'linkvertise';
}
function progressStepStartAt(progress, n) {
  return Number(progress?.[`step${n}_start_at`] || 0);
}
function normalizeItemName(name, fallback) {
  const n = String(name || "").trim();
  return n ? n.slice(0, 60) : fallback;
}
function isHttpUrl(s) {
  try {
    const u = new URL(String(s || ""));
    return u.protocol === "http:" || u.protocol === "https:";
  } catch { return false; }
}


async function recordAdsComplete(env, userId, itemType, itemId, itemName, now) {
  try {
    const dayTs = now - (now % 86400);
    const safeType = itemType === "shorturl" ? "shorturl" : "key";
    const safeId = String(itemId || "default").slice(0, 64);
    const fallbackName = safeType === "shorturl" ? `ShortUrl ${safeId}` : `Key ${safeId}`;
    const safeName = String(itemName || fallbackName).slice(0, 100);

    await env.DB.prepare(`
      INSERT INTO ads_daily_stats (user_id, day_ts, item_type, item_id, item_name, count)
      VALUES (?, ?, ?, ?, ?, 1)
      ON CONFLICT(user_id, day_ts, item_type, item_id) DO UPDATE SET
        count     = count + 1,
        item_name = excluded.item_name
    `).bind(userId, dayTs, safeType, safeId, safeName).run();
  } catch {}
}

export default {
  async fetch(request, env, ctx) {
    try { return await handleRequest(request, env, ctx); }
    catch (err) {
      return new Response(JSON.stringify({ status: false, error: "internal_error", message: err?.message || "unknown" }), {
        status:  500,
        headers: { ...getCors(request), "Content-Type": "application/json" },
      });
    }
  },
};

async function handleRequest(request, env, ctx) {
  const url  = new URL(request.url);
  const type = url.searchParams.get("type");
  const ua   = request.headers.get("User-Agent") || "";

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: getCors(request) });
  }

  if (type === "init") {
    let hwid, ostime;
    try {
      const body = await request.json();
      hwid   = typeof body.hwid === "string" ? body.hwid.replace(/ /g, "+") : body.hwid;
      ostime = body.ostime;
    } catch { return json({ status: false, error: "invalid_body" }, 400, request); }

    if (!hwid || !ostime) return json({ status: false, error: "missing_params" }, 400, request);
    if (hwid.length > 200) return json({ status: false, error: "invalid_hwid" }, 400, request);

    const now    = Math.floor(Date.now() / 1000);
    const cutoff = now - SESSION_TTL;
    const ip     = request.headers.get("CF-Connecting-IP") || "unknown";

    const blRow = await env.DB.prepare("SELECT ip FROM ip_blacklist WHERE ip = ?").bind(ip).first();
    if (blRow) return json({ status: false, error: "ip_blacklisted" }, 403, request);

    let trackRow = await env.DB.prepare("SELECT hwids, first_seen FROM ip_tracking WHERE ip = ?").bind(ip).first();
    let hwids      = [];
    let first_seen = now;

    if (trackRow) {
      if (now - trackRow.first_seen > IP_WINDOW) {
        await env.DB.prepare("DELETE FROM ip_tracking WHERE ip = ?").bind(ip).run();
      } else {
        try { hwids = JSON.parse(trackRow.hwids); } catch {}
        first_seen = trackRow.first_seen;
      }
    }

    if (!hwids.includes(hwid)) hwids.push(hwid);

    if (hwids.length >= IP_MAX_HWID) {
      await env.DB.prepare(
        "INSERT INTO ip_blacklist (ip, banned_at, reason) VALUES (?, ?, ?) ON CONFLICT(ip) DO NOTHING"
      ).bind(ip, now, "exceeded_hwid_limit").run();
      return json({ status: false, error: "ip_blacklisted", reason: "exceeded_hwid_limit" }, 403, request);
    }

    await env.DB.prepare(
      `INSERT INTO ip_tracking (ip, hwids, first_seen) VALUES (?, ?, ?)
       ON CONFLICT(ip) DO UPDATE SET hwids=excluded.hwids`
    ).bind(ip, JSON.stringify(hwids), first_seen).run();

    try {
      await env.DB.prepare("DELETE FROM progress WHERE hwid != ? AND created_at < ?").bind(hwid, cutoff).run();
    } catch {}

    await env.DB.prepare(
      `INSERT INTO progress (hwid, ostime, start, step1, step2, step3, step4, step5, step6, step7, step8, created_at) VALUES (?, ?, 0, 0, 0, 0, 0, 0, 0, 0, 0, ?)
       ON CONFLICT(hwid) DO UPDATE SET ostime=excluded.ostime, start=0, step1=0, step2=0, step3=0, step4=0, step5=0, step6=0, step7=0, step8=0, created_at=excluded.created_at`
    ).bind(hwid, ostime, now).run();

    return json({ status: true, message: "initialized" }, request);
  }

  if (type === "progress") {
    const hwid   = normalizeHwid(url);
    const flowId = url.searchParams.get("flow") || "default";
    if (!hwid) return json({ status: false, error: "missing_hwid" }, 400, request);

    const row = await env.DB.prepare("SELECT * FROM progress WHERE hwid = ? AND flow_id = ?").bind(hwid, flowId).first();
    if (!row) {
      const empty = { status: false, start: false };
      for (let i = 1; i <= MAX_FLOW_STEPS; i++) {
        empty[`step${i}`] = false;
        empty[`step${i}_start_at`] = null;
      }
      return json(empty, 200, request);
    }

    const out = { status: true, hwid: row.hwid, start: !!row.start };
    for (let i = 1; i <= MAX_FLOW_STEPS; i++) {
      out[`step${i}`] = !!row[`step${i}`];
      out[`step${i}_start_at`] = row[`step${i}_start_at`] || null;
    }
    return json(out, request);
  }

  if (type === "data") {
    const hwid = normalizeHwid(url);
    if (!hwid) return json({ status: false, error: "missing_hwid" }, 404, request);
    if (!env["ntt-system"]) return json({ status: false, error: "data_not_bound" }, 500, request);

    const result = await env["ntt-system"].getWithMetadata(`${url.searchParams.get("domain") || "default"}/${hwid}`);
    if (!result?.value) return json({ status: false, error: "key_not_found" }, 404, request);

    const key     = result.value;
    const created = result.metadata?.created;
    const ttl     = result.metadata?.ttl || 86400;
    const now     = Math.floor(Date.now() / 1000);
    const left    = created ? Math.max(0, ttl - (now - created)) : 0;
    const domain  = url.searchParams.get("domain") || result.metadata?.domain || "";

    let baseKey = env.ENCODE_KEY || "ntt-hub";
    if (domain) {
      const settings = await env.DB.prepare("SELECT encode_key FROM user_settings WHERE website_domain = ?")
        .bind(domain).first();
      if (settings?.encode_key) baseKey = settings.encode_key;
    }

    const payload = key + "|" + left;
    const encoded = encodeData(payload, baseKey);
    return text(encoded, 200, request);
  }

  if (type === "read") {
    const hwid = normalizeHwid(url);
    if (!hwid) return json({ status: "error", message: "Missing hwid" }, 400, request);

    const readDomain = url.searchParams.get("domain") || "";
    const kvKey = readDomain ? `${readDomain}/${hwid}` : `Key/${hwid}`;
    const result = await env["ntt-system"].getWithMetadata(kvKey);
    if (!result?.value)
      return json({ status: "error", message: "Key not found or expired" }, 404, request);

    const now     = Math.floor(Date.now() / 1000);
    const created = result.metadata?.created;
    const ttl     = result.metadata?.ttl || 86400;
    const left    = created ? Math.max(0, ttl - (now - created)) : null;

    return json({ status: "success", hwid, key: result.value, left }, 200, request);
  }

  if (type === "get_system_settings") {
    const s = await env.DB.prepare("SELECT * FROM system_settings WHERE id = 1").first();
    return json({ success: true, settings: s || {} }, request);
  }

  if (type === "save_system_settings") {
    let body;
    try { body = await request.json(); }
    catch { return json({ success: false, error: "Invalid JSON" }, 400, request); }

    const { start_type, start_link, start_yt_links, linkvertise_token } = body;
    const now = Math.floor(Date.now() / 1000);

    await env.DB.prepare(`
      INSERT INTO system_settings (id, start_type, start_link, start_yt_links, linkvertise_token, updated_at)
      VALUES (1, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        start_type        = excluded.start_type,
        start_link        = excluded.start_link,
        start_yt_links    = excluded.start_yt_links,
        linkvertise_token = excluded.linkvertise_token,
        updated_at        = excluded.updated_at
    `).bind(
      start_type || "linkvertise",
      start_link || "",
      start_yt_links || "[]",
      linkvertise_token || "",
      now
    ).run();

    return json({ success: true, message: "System settings saved" }, request);
  }

  if (type === "get_start_link") {
    return json({
      success: true,
      start_link: env.SYSTEM_START_LINK || "",
    }, request);
  }

  if (type === "captcha_new") {
    // Chỉ cho phép request từ web trong ALLOWED_ORIGINS
    const origin = request.headers.get("Origin") || "";
    if (!ALLOWED_ORIGINS.includes(origin)) {
      return json({ success: false, error: "forbidden" }, 403, request);
    }

    const hwidRaw   = url.searchParams.get("hwid");
    const domainArg = url.searchParams.get("domain") || "";
    const hwid      = hwidRaw ? hwidRaw.replace(/ /g, "+") : null;
    if (!hwid) return json({ success: false, error: "missing_hwid" }, 400, request);
    const lang = getLang(request);

    const now = Math.floor(Date.now() / 1000);

    // Rate limit reload: 3 lần / 60 giây / hwid
    const windowStart = now - 60;
    const rlRow = await env.DB.prepare(
      "SELECT count, window_start FROM captcha_refresh_limit WHERE hwid = ?"
    ).bind(hwid).first();

    if (rlRow) {
      if (rlRow.window_start < windowStart) {
        // Window mới → reset
        await env.DB.prepare(
          "UPDATE captcha_refresh_limit SET count = 1, window_start = ? WHERE hwid = ?"
        ).bind(now, hwid).run();
      } else if (rlRow.count >= 3) {
        const retryAfter = Math.max(1, 60 - (now - rlRow.window_start));
        return json({ success: false, error: "rate_limited", message: "Too many refreshes.", retry_after: retryAfter }, 429, request);
      } else {
        await env.DB.prepare(
          "UPDATE captcha_refresh_limit SET count = count + 1 WHERE hwid = ?"
        ).bind(hwid).run();
      }
    } else {
      await env.DB.prepare(
        "INSERT INTO captcha_refresh_limit (hwid, count, window_start) VALUES (?, 1, ?)"
      ).bind(hwid, now).run();
    }

    // Cleanup session cũ
    await env.DB.prepare("DELETE FROM captcha_sessions WHERE hwid = ? OR created_at < ?")
      .bind(hwid, now - 600).run();

    // Đọc settings: captcha_type + captcha_lockout
    let captchaType    = "text";
    let captchaLockout = 0; // mặc định TẮT — chỉ bật khi D1 trả về 1
    if (domainArg) {
      try {
        const us = await env.DB.prepare("SELECT captcha_type, captcha_lockout FROM user_settings WHERE website_domain = ?").bind(domainArg).first();
        if (us?.captcha_type) captchaType = us.captcha_type;
        captchaLockout = Number(us?.captcha_lockout ?? 0);
      } catch {}
    }

    // Block On Fail: check D1
    const failKey = `${hwid}:${domainArg}`;
    if (captchaLockout === 1) {
      const now5 = Math.floor(Date.now() / 1000) - 300;
      const failRow = await env.DB.prepare(
        "SELECT count FROM captcha_fails WHERE hwid = ? AND domain = ? AND updated_at > ?"
      ).bind(hwid, domainArg, now5).first();
      const failCount = failRow?.count || 0;
      if (failCount >= 3) {
        return json({ success: false, error: "too_many_failures", message: "Too many wrong attempts. Please wait 5 minutes." }, 429, request);
      }
    }

    const id = crypto.randomUUID();

    const ri = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;

    // ── NORMAL captcha (shapes + blocks) ─────────────────────────────────
    if (captchaType === "image" || captchaType === "normal") {
      const COLORS = ['#00e5ff','#06ffa5','#c4b5fd','#fbbf24','#f87171','#34d399','#f472b6','#60a5fa'];
      const rc = () => COLORS[ri(0, COLORS.length - 1)];

      // LOẠI 1 — Chọn hình
      const buildType1 = async () => {
        const SHAPES = ['circle', 'square', 'triangle', 'star'];
        const target = SHAPES[ri(0, 3)];
        const labelMap = { circle: 'circles', square: 'squares', triangle: 'triangles', star: 'stars' };
        const correctCount = ri(2, 4);
        const cells = [];
        for (let i = 0; i < 9; i++) cells.push(i < correctCount ? target : SHAPES.filter(s => s !== target)[ri(0,2)]);
        for (let i = cells.length - 1; i > 0; i--) { const j = ri(0, i); [cells[i], cells[j]] = [cells[j], cells[i]]; }
        const correctIndices = cells.reduce((acc, s, i) => { if (s === target) acc.push(i); return acc; }, []);
        const tiles = cells.map(shape => renderShapePng(shape, rc(), ri));
        const shapesPrompt = `${t('select_all',lang)} <b>${t(labelMap[target],lang)}</b>`;
        return { subtype: 'shapes', prompt: shapesPrompt, tiles, correctIndices, answer: JSON.stringify(correctIndices), category: `shapes:${target}`, multi: true };
      };

      // LOẠI 2 — Cột đá chồng
      const buildType2 = async () => {
        const colCount = ri(5, 7);
        const pool = [1,2,3,4,5,6,7].sort(() => Math.random() - 0.5);
        const heights = pool.slice(0, colCount);
        const target  = ri(0, colCount - 1);
        const targetH = heights[target];
        const blocksPrompt = `${t('select_col',lang)} <b>${targetH}</b> ${t(targetH>1?'blocks':'block',lang)} ${t('stacked',lang)}`;
        return { subtype: 'blocks', prompt: blocksPrompt, svgImage: renderBlocksPng(heights, colCount, ri), svgWidth: colCount * 54 + 16, svgHeight: 7 * 22 + 44, colCount, correctIndices: [target], answer: String(target), category: `blocks:${targetH}:${target}`, multi: false };
      };

      const built = await (ri(0,1) === 0 ? buildType1() : buildType2());
      await env.DB.prepare(
        "INSERT INTO captcha_sessions (id, answer, hwid, used, created_at, category, correct_indices, domain) VALUES (?, ?, ?, 0, ?, ?, ?, ?)"
      ).bind(id, built.answer, hwid, now, built.category, JSON.stringify(built.correctIndices), domainArg).run();

      const base = { success: true, id, type: "normal", subtype: built.subtype, prompt: built.prompt };
      if (built.subtype === 'shapes') return json({ ...base, tiles: built.tiles, multi: true }, request);
      if (built.subtype === 'blocks') return json({ ...base, svgImage: built.svgImage, svgWidth: built.svgWidth, svgHeight: built.svgHeight, colCount: built.colCount, multi: false }, request);
    }

    // ── HIGH captcha (Phân mảnh + Chuỗi loạn) ────────────────────────────
    if (captchaType === "high") {
      const typeRoll = ri(0, 1);

      // ── HIGH LOẠI 1: Phân mảnh ──────────────────────────────────────────
      if (typeRoll === 0) {
        const SHAPE_LIST  = ['square', 'circle', 'star', 'triangle'];
        const COLOR_NAMES = ['red', 'blue', 'yellow', 'purple'];
        const COLOR_RGB   = { red: [239,68,68], blue: [59,130,246], yellow: [234,179,8], purple: [168,85,247] };

        // Chọn 2 hình + 2 màu → 4 combo, mỗi combo 2-4 cái, không đè nhau
        const shapes   = [...SHAPE_LIST].sort(() => Math.random()-0.5).slice(0, 2);
        const colors   = [...COLOR_NAMES].sort(() => Math.random()-0.5).slice(0, 2);
        const countMap = {};
        const objects  = [];

        // Đặt hình không đè nhau — thử tối đa 30 lần mỗi hình
        const placed = [];
        const minDist = 44; // khoảng cách tối thiểu giữa 2 tâm
        const tryPlace = (shape, color) => {
          for (let attempt = 0; attempt < 30; attempt++) {
            const x = ri(22, 298), y = ri(22, 178), size = ri(14, 20);
            const ok = placed.every(p => Math.hypot(p.x-x, p.y-y) >= minDist);
            if (ok) { placed.push({x,y}); return { shape, color: COLOR_RGB[color], x, y, size, rot: ri(0,359) }; }
          }
          return null;
        };

        for (const shape of shapes) {
          for (const color of colors) {
            const count = ri(2, 4);
            countMap[`${color}_${shape}`] = 0;
            for (let k = 0; k < count; k++) {
              const obj = tryPlace(shape, color);
              if (obj) { objects.push(obj); countMap[`${color}_${shape}`]++; }
            }
            // Đảm bảo ít nhất 1 cái
            if (countMap[`${color}_${shape}`] === 0) {
              const obj = tryPlace(shape, color);
              if (obj) { objects.push(obj); countMap[`${color}_${shape}`] = 1; }
            }
          }
        }

        // Shuffle để không vẽ theo nhóm màu
        for (let i = objects.length-1; i > 0; i--) {
          const j = ri(0, i); [objects[i], objects[j]] = [objects[j], objects[i]];
        }

        // Chọn 1 combo làm câu hỏi
        const allCombos  = Object.keys(countMap);
        const askCombo   = allCombos[ri(0, allCombos.length-1)];
        const [askColor, askShape] = askCombo.split('_');
        const answer     = String(countMap[askCombo]);

        const shapeLabel = { square: 'squares', circle: 'circles', star: 'stars', triangle: 'triangles' };
        const colorHex = askColor==='red'?'ef4444':askColor==='blue'?'3b82f6':askColor==='yellow'?'eab308':'a855f7';
        const prompt = `${t('how_many',lang)} <b style="color:#${colorHex}">${t(askColor,lang)}</b> ${t(shapeLabel[askShape],lang)} ${t('are_there',lang)}`;

        const image = renderFragmentPng(objects, ri);

        await env.DB.prepare(
          "INSERT INTO captcha_sessions (id, answer, hwid, used, created_at, category, correct_indices, domain) VALUES (?, ?, ?, 0, ?, ?, ?, ?)"
        ).bind(id, answer, hwid, now, `fragment:${askCombo}`, '[]', domainArg).run();

        return json({ success: true, id, type: "high", subtype: "fragment", prompt, image }, request);
      }

      // ── HIGH LOẠI 2: Chuỗi loạn ─────────────────────────────────────────
      const CHARS  = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
      const length = ri(7, 8);
      let charArr  = [];
      for (let i = 0; i < length; i++) charArr.push(CHARS[Math.floor(Math.random() * CHARS.length)]);

      // Chọn 3-4 vị trí ngẫu nhiên không trùng nhau
      const askCount = ri(3, 4);
      const allIdx   = Array.from({length}, (_,i) => i).sort(() => Math.random()-0.5);
      const targetIndices = allIdx.slice(0, askCount).sort((a,b) => a-b);
      // Answer là chuỗi các ký tự tương ứng, cách nhau space: "A 3 K"
      const answer = targetIndices.map(idx => charArr[idx]).join(' ');
      // Prompt: "Enter characters at positions 2, 5, 7"
      const posStr = targetIndices.map(idx => idx+1).join(', ');
      const prompt = `${t('enter_chars',lang)} <b>${posStr}</b>`;

      const chaosResult = renderChaosPng(charArr, targetIndices, ri);
      const chaosImage = chaosResult.image;
      const displayNums = chaosResult.displayNums;

      // posStr và answer dùng số hiển thị (displayNums) thay vì index thật
      const displayPosStr = targetIndices.map(idx => displayNums[idx]).sort((a,b)=>a-b).join(', ');
      const displayPrompt = `${t('enter_chars',lang)} <b>${displayPosStr}</b>`;
      // Answer: ký tự tại targetIndices, theo thứ tự displayNum tăng dần
      const sortedByDisplay = targetIndices
        .map(idx => ({ idx, dispNum: displayNums[idx], ch: charArr[idx] }))
        .sort((a,b) => a.dispNum - b.dispNum);
      const displayAnswer = sortedByDisplay.map(o => o.ch).join(' ');

      await env.DB.prepare(
        "INSERT INTO captcha_sessions (id, answer, hwid, used, created_at, category, correct_indices, domain) VALUES (?, ?, ?, 0, ?, ?, ?, ?)"
      ).bind(id, displayAnswer, hwid, now, `chaos:${targetIndices.join(',')}`, '[]', domainArg).run();

      return json({ success: true, id, type: "high", subtype: "chaos", prompt: displayPrompt, image: chaosImage }, request);
    }


    // ── TEXT CAPTCHA (SVG) ────────────────────────────────────
    const chars  = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let answer   = "";
    for (let i = 0; i < 5; i++) answer += chars[Math.floor(Math.random() * chars.length)];

    await env.DB.prepare(
      "INSERT INTO captcha_sessions (id, answer, hwid, used, created_at, domain) VALUES (?, ?, ?, 0, ?, ?)"
    ).bind(id, answer, hwid, now, domainArg).run();


    // Render thẳng PNG từ answer — không qua SVG
    const pngB64 = renderTextCaptchaPng(answer, ri);

    return json({ success: true, id, type: "text", image: `data:image/png;base64,${pngB64}` }, request);
  }

  if (type === "captcha_verify") {
    let body;
    try { body = await request.json(); }
    catch { return json({ success: false, error: "Invalid JSON" }, 400, request); }

    let { id, answer, hwid, selected_indices } = body;
    if (hwid) hwid = hwid.replace(/ /g, "+");
    if (!id || !hwid) return json({ success: false, error: "Missing params" }, 400, request);

    const now     = Math.floor(Date.now() / 1000);
    const row = await env.DB.prepare("SELECT * FROM captcha_sessions WHERE id = ?").bind(id).first();

    if (!row)              return json({ success: false, error: "Invalid captcha" }, 403, request);
    if (row.used)          return json({ success: false, error: "Captcha already used" }, 403, request);
    if (row.hwid !== hwid) return json({ success: false, error: "Invalid captcha" }, 403, request);
    if (now - row.created_at > 120) {
      await env.DB.prepare("DELETE FROM captcha_sessions WHERE id = ?").bind(id).run();
      return json({ success: false, error: "Captcha expired" }, 403, request);
    }
    // Bot guard: giải quá nhanh trong 5s → reject (check sau incFail declaration)
    const tooFast = (now - row.created_at) < 5;

    // Domain lưu thẳng trong captcha_sessions
    let verifyDomain  = row.domain || "";
    let verifyLockout = 1;
    if (verifyDomain) {
      try {
        const us = await env.DB.prepare("SELECT captcha_lockout FROM user_settings WHERE website_domain = ?")
          .bind(verifyDomain).first();
        if (us?.captcha_lockout !== undefined && us?.captcha_lockout !== null) verifyLockout = Number(us.captcha_lockout);
      } catch {}
    }

    const incFail = async () => {
      if (verifyLockout !== 1 || !verifyDomain) return;
      const nowF = Math.floor(Date.now() / 1000);
      await env.DB.prepare(`
        INSERT INTO captcha_fails (hwid, domain, count, updated_at) VALUES (?, ?, 1, ?)
        ON CONFLICT(hwid, domain) DO UPDATE SET
          count      = CASE WHEN updated_at < ? THEN 1 ELSE count + 1 END,
          updated_at = ?
      `).bind(row.hwid, verifyDomain, nowF, nowF - 300, nowF).run();
    };

    const clearFail = async () => {
      if (!verifyDomain) return;
      await env.DB.prepare("DELETE FROM captcha_fails WHERE hwid = ? AND domain = ?")
        .bind(row.hwid, verifyDomain).run();
    };

    const cat = row.category || "";
    // Bot guard: reject nếu giải dưới 5 giây
    if (tooFast) {
      await env.DB.prepare("DELETE FROM captcha_sessions WHERE id = ?").bind(id).run();
      await incFail();
      return json({ success: false, error: "Wrong answer" }, 403, request);
    }

    const isHighTextCaptcha = cat.startsWith("fragment:") || cat.startsWith("chaos:");
    const isImageCaptcha    = cat.length > 0 && !isHighTextCaptcha;

    if (isHighTextCaptcha) {
      // ── HIGH verify (fragment: đếm số / chaos: ký tự) ──
      if (!answer) return json({ success: false, error: "Missing answer" }, 400, request);
      const normalise = s => s.toString().toUpperCase().trim().replace(/\s+/g,' ');
      const given  = normalise(answer);
      const expect = normalise(row.answer);
      if (given !== expect) {
        await env.DB.prepare("DELETE FROM captcha_sessions WHERE id = ?").bind(id).run();
        await incFail();
        return json({ success: false, error: "Wrong answer" }, 403, request);
      }
    } else if (isImageCaptcha) {
      // ── NORMAL verify (shapes / blocks) ──
      if (!selected_indices || !Array.isArray(selected_indices))
        return json({ success: false, error: "Missing selected_indices" }, 400, request);

      let correctIndices = [];
      try { correctIndices = JSON.parse(row.correct_indices || "[]"); } catch {}

      const sel     = [...selected_indices].map(Number).sort((a,b) => a-b);
      const correct = [...correctIndices].sort((a,b) => a-b);
      const isOk    = sel.length === correct.length && sel.every((v,i) => v === correct[i]);

      if (!isOk) {
        await env.DB.prepare("DELETE FROM captcha_sessions WHERE id = ?").bind(id).run();
        await incFail();
        return json({ success: false, error: "Wrong selection" }, 403, request);
      }
    } else {
      // ── TEXT verify (default) ──
      if (!answer) return json({ success: false, error: "Missing answer" }, 400, request);
      if (row.answer !== answer.toUpperCase().trim()) {
        await env.DB.prepare("DELETE FROM captcha_sessions WHERE id = ?").bind(id).run();
        await incFail();
        return json({ success: false, error: "Wrong answer" }, 403, request);
      }
    }

    // Thành công — clear fail counter
    await clearFail();
    const token = crypto.randomUUID();
    await env.DB.prepare("UPDATE captcha_sessions SET used = 1, id = ? WHERE id = ?")
      .bind(token, id).run();
    return json({ success: true, token }, request);
  }

  if (type === "mark_step_start") {
    let body;
    try { body = await request.json(); }
    catch { return json({ success: false, error: "Invalid JSON" }, 400, request); }

    let { hwid, step, flow_id } = body;
    if (hwid) hwid = hwid.replace(/ /g, "+");
    const stepNum = Number(step);
    if (!hwid || !Number.isInteger(stepNum) || stepNum < 1 || stepNum > MAX_FLOW_STEPS)
      return json({ success: false, error: "Invalid step" }, 400, request);

    const flowKey = flow_id ? String(flow_id) : "default";
    const now = Math.floor(Date.now() / 1000);
    const col = `step${stepNum}_start_at`;

    const existing = await env.DB.prepare("SELECT * FROM progress WHERE hwid = ? AND flow_id = ?").bind(hwid, flowKey).first();
    if (!existing || !existing.start) {
      return json({ success: false, error: "start_required", message: "Please complete captcha first" }, 403, request);
    }
    if (stepNum > 1 && !existing[`step${stepNum - 1}`]) {
      return json({ success: false, error: `step${stepNum - 1}_required`, message: `Please complete step ${stepNum - 1} first` }, 403, request);
    }

    await env.DB.prepare(`UPDATE progress SET ${col} = ? WHERE hwid = ? AND flow_id = ?`).bind(now, hwid, flowKey).run();

    return json({ success: true });
  }

  if (type === "save_captcha_type") {
    let body;
    try { body = await request.json(); }
    catch { return json({ success: false, error: "Invalid JSON" }, 400, request); }

    const { user_id, captcha_type } = body;
    if (!user_id) return json({ success: false, error: "Missing user_id" }, 400, request);
    if (!["text", "image", "normal", "high"].includes(captcha_type))
      return json({ success: false, error: "Invalid captcha_type" }, 400, request);

    const authHeader = request.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer "))
      return json({ success: false, error: "Unauthorized" }, 401, request);
    const authPayload = await verifyToken(authHeader.slice(7));
    if (!authPayload)
      return json({ success: false, error: "Invalid or expired token" }, 401, request);
    if (String(authPayload.userId) !== String(user_id))
      return json({ success: false, error: "Forbidden" }, 403, request);

    await env.DB.prepare(
      "UPDATE user_settings SET captcha_type = ?, updated_at = ? WHERE user_id = ?"
    ).bind(captcha_type, Math.floor(Date.now() / 1000), user_id).run();

    return json({ success: true, message: "Captcha type saved" }, request);
  }

  if (type === "save_captcha_lockout") {
    let body;
    try { body = await request.json(); }
    catch { return json({ success: false, error: "Invalid JSON" }, 400, request); }

    const { user_id, captcha_lockout } = body;
    if (!user_id) return json({ success: false, error: "Missing user_id" }, 400, request);
    if (![0, 1].includes(Number(captcha_lockout)))
      return json({ success: false, error: "Invalid captcha_lockout value" }, 400, request);

    const authHeader = request.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer "))
      return json({ success: false, error: "Unauthorized" }, 401, request);
    const authPayload = await verifyToken(authHeader.slice(7));
    if (!authPayload)
      return json({ success: false, error: "Invalid or expired token" }, 401, request);
    if (String(authPayload.userId) !== String(user_id))
      return json({ success: false, error: "Forbidden" }, 403, request);

    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      "UPDATE user_settings SET captcha_lockout = ?, updated_at = ? WHERE user_id = ?"
    ).bind(Number(captcha_lockout), now, user_id).run();

    // Nếu tắt lockout → xóa hết fail counter của domain này trong D1
    if (Number(captcha_lockout) === 0) {
      try {
        // Xóa toàn bộ captcha_fails — unblock hết ngay lập tức
        await env.DB.prepare("DELETE FROM captcha_fails").run();
      } catch {}
    }

    return json({ success: true, message: "Captcha lockout saved" }, request);
  }

  // Unblock tất cả hwid bị chặn của domain — gọi thủ công từ dashboard
  if (type === "unblock_all") {
    let body;
    try { body = await request.json(); }
    catch { return json({ success: false, error: "Invalid JSON" }, 400, request); }

    const { user_id } = body;
    if (!user_id) return json({ success: false, error: "Missing user_id" }, 400, request);

    const authHeader = request.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer "))
      return json({ success: false, error: "Unauthorized" }, 401, request);
    const authPayload = await verifyToken(authHeader.slice(7));
    if (!authPayload || String(authPayload.userId) !== String(user_id))
      return json({ success: false, error: "Forbidden" }, 403, request);

    try {
      const us = await env.DB.prepare("SELECT website_domain FROM user_settings WHERE user_id = ?").bind(user_id).first();
      if (us?.website_domain) {
        // Xóa theo website_domain
        await env.DB.prepare("DELETE FROM captcha_fails WHERE domain = ?").bind(us.website_domain).run();
      }
      // Xóa tất cả — không phân biệt domain (đảm bảo không còn sót)
      const result = await env.DB.prepare("DELETE FROM captcha_fails").run();
      return json({ success: true, deleted: result.meta?.changes || 0 }, request);
    } catch (e) {
      return json({ success: false, error: e.message }, 500, request);
    }
  }

  if (type === "save_best_time") {
    let body;
    try { body = await request.json(); }
    catch { return json({ success: false, error: "Invalid JSON" }, 400, request); }

    const { user_id, best_time_enabled } = body;
    if (!user_id) return json({ success: false, error: "Missing user_id" }, 400, request);

    const authHeader = request.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer "))
      return json({ success: false, error: "Unauthorized" }, 401, request);
    const authPayload = await verifyToken(authHeader.slice(7));
    if (!authPayload)
      return json({ success: false, error: "Invalid or expired token" }, 401, request);
    if (String(authPayload.userId) !== String(user_id))
      return json({ success: false, error: "Forbidden" }, 403, request);

    const enabled = [0, 1].includes(Number(best_time_enabled)) ? Number(best_time_enabled) : 0;

    await env.DB.prepare(
      "UPDATE user_settings SET best_time_enabled = ?, updated_at = ? WHERE user_id = ?"
    ).bind(enabled, Math.floor(Date.now() / 1000), user_id).run();

    return json({ success: true, message: "Best time setting saved" }, request);
  }

  if (type === "complete_step") {
    let body;
    try { body = await request.json(); }
    catch { return json({ success: false, error: "Invalid JSON" }, 400, request); }

    let { hwid, step, hash, domain, flow_id, key_id, shorturl_id, captcha_token } = body;
    if (hwid) hwid = hwid.replace(/ /g, "+");
    if (!hwid || !step || !domain) return json({ success: false, error: "Missing params" }, 400, request);
    if (hwid.length > 200) return json({ success: false, error: "Invalid hwid" }, 400, request);

    const isStartStep = step === "start";
    const stepNum = isStartStep ? 0 : Number(step);
    if (!isStartStep && (!Number.isInteger(stepNum) || stepNum < 1 || stepNum > MAX_FLOW_STEPS))
      return json({ success: false, error: "Invalid step" }, 400, request);

    let flowKey = flow_id ? String(flow_id) : "default";

    if (isStartStep) {
      if (!captcha_token) return json({ success: false, error: "captcha_required" }, 403, request);
      const ct = await env.DB.prepare("SELECT * FROM captcha_sessions WHERE id = ?").bind(captcha_token).first();
      if (!ct || !ct.used || ct.hwid !== hwid) return json({ success: false, error: "invalid_captcha_token" }, 403, request);
      await env.DB.prepare("DELETE FROM captcha_sessions WHERE id = ?").bind(captcha_token).run();
    }

    const userSettings = await env.DB.prepare("SELECT * FROM user_settings WHERE website_domain = ?").bind(domain).first();
    if (!userSettings) return json({ success: false, error: "domain_not_found" }, 404, request);

    if ((!flow_id || flowKey === "default") && key_id) {
      const keyItem = await env.DB.prepare("SELECT flow_id FROM key_links WHERE user_id = ? AND item_id = ?")
        .bind(userSettings.user_id, key_id).first();
      if (!keyItem) return json({ success: false, error: "key_link_not_found" }, 404, request);
      flowKey = String(keyItem.flow_id || "default");
    }

    if ((!flow_id || flowKey === "default") && shorturl_id) {
      const shortItem = await env.DB.prepare("SELECT flow_id FROM shorturl_items WHERE user_id = ? AND item_id = ?")
        .bind(userSettings.user_id, shorturl_id).first();
      if (!shortItem) return json({ success: false, error: "shorturl_not_found" }, 404, request);
      flowKey = String(shortItem.flow_id || "default");
    }

    const effectiveStepTypes = {};
    for (let i = 1; i <= MAX_FLOW_STEPS; i++) effectiveStepTypes[i] = stepTypeValue(userSettings, i);
    if (flowKey !== "default") {
      const flowRow = await env.DB.prepare("SELECT * FROM user_flows WHERE user_id = ? AND flow_id = ?")
        .bind(userSettings.user_id, flowKey).first();
      if (flowRow) for (let i = 1; i <= MAX_FLOW_STEPS; i++) effectiveStepTypes[i] = stepTypeValue(flowRow, i);
    }

    const stepType = isStartStep ? "captcha_start" : (effectiveStepTypes[stepNum] || "linkvertise");
    const PLATFORM_SECS = (t) => t === "lootlab" ? 60 : t === "workink" ? 30 : t === "youtube" ? 15 : 10;
    const effectiveBestTimeEnabled = userSettings.best_time_enabled || 0;

    if (isStartStep) {
      // Start chỉ xác thực captcha, không còn là ads/admin step.
    } else if (stepType === "linkvertise") {
      if (!userSettings.linkvertise_token?.trim()) return json({ success: false, error: "missing_linkvertise_token" }, 403, request);
      if (!hash || hash.length < 10) return json({ success: false, error: "missing_hash" }, 403, request);
      const valid = await checkLinkvertiseHash(hash, userSettings.linkvertise_token, ua);
      if (!valid) return json({ success: false, error: "invalid_hash" }, 403, request);
    }

    const now = Math.floor(Date.now() / 1000);
    let progress = await env.DB.prepare("SELECT * FROM progress WHERE hwid = ? AND flow_id = ?").bind(hwid, flowKey).first();

    if (!progress) {
      const defaultP = await env.DB.prepare("SELECT created_at FROM progress WHERE hwid = ? AND flow_id = 'default'").bind(hwid).first();
      const initTime = defaultP?.created_at || now;
      await env.DB.prepare(
        `INSERT INTO progress (hwid, ostime, start, step1, step2, step3, step4, step5, step6, step7, step8, created_at, flow_id)
         VALUES (?, ?, 0, 0, 0, 0, 0, 0, 0, 0, 0, ?, ?)`
      ).bind(hwid, now, initTime, flowKey).run();
      progress = { created_at: initTime, start: 0 };
      for (let i = 1; i <= MAX_FLOW_STEPS; i++) progress[`step${i}`] = 0;
    }

    if (!isStartStep && !progress.start) {
      return json({ success: false, error: "start_required", message: "Please complete captcha first" }, 403, request);
    }
    if (!isStartStep && stepNum > 1 && !progress[`step${stepNum - 1}`]) {
      return json({ success: false, error: `step${stepNum - 1}_required`, message: `Please complete step ${stepNum - 1} first` }, 403, request);
    }

    if (!isStartStep) {
      const hasToken = stepType === "linkvertise" && userSettings.linkvertise_token?.trim();
      if (!hasToken) {
        const bypassSecs = effectiveBestTimeEnabled === 1 ? PLATFORM_SECS(stepType) : 25;
        const startAt = progressStepStartAt(progress, stepNum);
        if (!startAt) return json({ success: false, error: "bypass_detected", message: "Please click the step button first" }, 403, request);
        const elapsed = now - startAt;
        if (elapsed < bypassSecs) {
          await env.DB.prepare(`UPDATE progress SET step${stepNum} = 0, step${stepNum}_start_at = NULL WHERE hwid = ? AND flow_id = ?`).bind(hwid, flowKey).run();
          return json({ success: false, error: "bypass_detected", message: "Too fast, please try again" }, 403, request);
        }
      }
    }

    if (isStartStep) {
      await env.DB.prepare("UPDATE progress SET start = 1, created_at = ? WHERE hwid = ? AND flow_id = ?").bind(now, hwid, flowKey).run();
    } else {
      await env.DB.prepare(`UPDATE progress SET start = 1, step${stepNum} = 1, step${stepNum}_at = ? WHERE hwid = ? AND flow_id = ?`).bind(now, hwid, flowKey).run();
    }

    return json({ success: true, message: `Step ${step} completed` }, request);
  }

  if (type === "create_key") {
    let body;
    try { body = await request.json(); }
    catch { return json({ success: false, error: "Invalid JSON" }, 400, request); }

    let { hwid, domain, flow_id, key_id } = body;
    if (hwid) hwid = hwid.replace(/ /g, "+");
    if (!hwid || !domain)
      return json({ success: false, error: "Missing params" }, 400, request);
    if (hwid.length > 200) return json({ success: false, error: "Invalid hwid" }, 400, request);

    const settings = await env.DB.prepare("SELECT * FROM user_settings WHERE website_domain = ?")
      .bind(domain).first();

    if (!settings)
      return json({ success: false, error: "Settings not found" }, 404, request);

    let keyItem = null;
    if (key_id) {
      keyItem = await env.DB.prepare("SELECT * FROM key_links WHERE user_id = ? AND item_id = ?")
        .bind(settings.user_id, key_id).first();
      if (!keyItem) return json({ success: false, error: "key_link_not_found" }, 404, request);
      flow_id = keyItem.flow_id;
    }

    const flowKey = flow_id ? String(flow_id) : "default";
    const progress = await env.DB.prepare("SELECT * FROM progress WHERE hwid = ? AND flow_id = ?").bind(hwid, flowKey).first();

    if (!progress)
      return json({ success: false, error: "No progress found. Please complete the steps." }, 403, request);

    // Merge flow settings nếu có flow_id. Key duration belongs to key_links now.
    let effectiveSettings = { ...settings, ad_steps: clampAdSteps(settings.ad_steps) };
    let keyTtl = keyItem ? safeKeyDuration(keyItem.key_duration) : 86400;
    if (flowKey !== "default") {
      const flowRow = await env.DB.prepare("SELECT * FROM user_flows WHERE user_id = ? AND flow_id = ?")
        .bind(settings.user_id, flowKey).first();
      if (flowRow) {
        effectiveSettings.ad_steps = clampAdSteps(flowRow.ad_steps);
        for (let i = 1; i <= MAX_FLOW_STEPS; i++) effectiveSettings[`step${i}_type`] = stepTypeValue(flowRow, i);
        if (!keyItem) keyTtl = safeKeyDuration(flowRow.key_duration);
      } else {
        return json({ success: false, error: "flow_not_found" }, 404, request);
      }
    }

    const now = Math.floor(Date.now() / 1000);

    // ── Best Time Anti-Bypass: tổng thời gian theo số step ads thật ──
    const requiredSteps = clampAdSteps(effectiveSettings.ad_steps);
    if (settings.best_time_enabled === 1) {
      const PSECS = (t) => t === "lootlab" ? 60 : t === "workink" ? 30 : t === "youtube" ? 15 : 10;
      let totalRequired = 0;
      for (let i = 1; i <= requiredSteps; i++) totalRequired += PSECS(effectiveSettings[`step${i}_type`] || "linkvertise");
      const elapsed = now - (progress.created_at || now);
      if (elapsed < totalRequired) {
        return json({ success: false, error: "bypass_detected", message: `Flow completed too fast (${elapsed}s < ${totalRequired}s required)` }, 403, request);
      }
    }

    for (let i = 1; i <= requiredSteps; i++) {
      if (!progress[`step${i}`]) return json({ success: false, error: `Step ${i} not completed` }, 403, request);
    }

    const keyId     = Math.random().toString().slice(2, 9);
    const keyPrefix = (settings.key_domain || "KEY").toUpperCase();
    const key       = `${keyPrefix}_${keyId}`;

    if (!env["ntt-system"])
      return json({ success: false, error: "KV not bound" }, 500, request);

    await env["ntt-system"].put(`${domain}/${hwid}`, key, {
      expirationTtl: keyTtl,
      metadata: { created: now, domain, ttl: keyTtl },
    });

    await env.DB.prepare(
      "UPDATE user_settings SET total_keys = total_keys + 1 WHERE website_domain = ?"
    ).bind(domain).run();

    await env.DB.prepare("DELETE FROM progress WHERE hwid = ? AND flow_id = ?").bind(hwid, flowKey).run();

    // Ghi thống kê key theo ngày
    try {
      const dayTs = now - (now % 86400);
      let flowNameForStat = "Default";
      if (flowKey !== "default") {
        const fnRow = await env.DB.prepare("SELECT name FROM user_flows WHERE user_id = ? AND flow_id = ?")
          .bind(settings.user_id, flowKey).first();
        if (fnRow) flowNameForStat = fnRow.name || `Flow ${flowKey}`;
      }
      await env.DB.prepare(`
        INSERT INTO key_daily_stats (user_id, day_ts, flow_id, flow_name, count)
        VALUES (?, ?, ?, ?, 1)
        ON CONFLICT(user_id, day_ts, flow_id) DO UPDATE SET
          count     = count + 1,
          flow_name = excluded.flow_name
      `).bind(settings.user_id, dayTs, flowKey, flowNameForStat).run();
    } catch {}

    await recordAdsComplete(
      env,
      settings.user_id,
      "key",
      keyItem?.item_id || key_id || flowKey,
      keyItem?.name || (key_id ? `Key ${key_id}` : `Flow ${flowKey}`),
      now
    );

    const updatedSettings = await env.DB.prepare(
      "SELECT total_keys, discord_webhook FROM user_settings WHERE website_domain = ?"
    ).bind(domain).first();

    let hwidsToday = 1;
    try {
      const tr = await env.DB.prepare("SELECT hwids FROM ip_tracking WHERE ip = ?")
        .bind(request.headers.get("CF-Connecting-IP") || "unknown").first();
      if (tr) hwidsToday = JSON.parse(tr.hwids).length;
    } catch {}

    if (updatedSettings?.discord_webhook) {
      let flowName = null;
      if (flowKey !== "default") {
        try {
          const flowRow = await env.DB.prepare("SELECT name FROM user_flows WHERE user_id = ? AND flow_id = ?")
            .bind(settings.user_id, flowKey).first();
          if (flowRow) flowName = flowRow.name;
        } catch {}
      }
      ctx.waitUntil(sendWebhook(updatedSettings.discord_webhook, { hwid, key, hwidsToday, flowKey, flowName }));
    }

    return json({
      success: true,
      key,
      expires_in: keyTtl,
      total_keys: updatedSettings?.total_keys || 1,
    }, request);
  }

  if (type === "register") {
    let body;
    try { body = await request.json(); }
    catch { return json({ success: false, error: "Invalid JSON" }, 400, request); }

    const { username, email, password } = body;
    if (!username || !email || !password)
      return json({ success: false, error: "All fields required" }, 400, request);

    if (!/^[a-zA-Z0-9_ ]+$/.test(username))
      return json({ success: false, error: "Username can only contain letters, numbers, spaces, and underscores" }, 400, request);

    if (username.length < 3 || username.length > 15)
      return json({ success: false, error: "Username must be 3-15 chars" }, 400, request);
    if (password.length < 6 || password.length > 20)
      return json({ success: false, error: "Password must be 6-20 chars" }, 400, request);

    const existing = await env.DB.prepare("SELECT id FROM users WHERE username = ? OR email = ?")
      .bind(username, email).first();
    if (existing)
      return json({ success: false, error: "Username or email exists" }, 409, request);

    const hashedPassword = await hashPassword(password);
    const now = Math.floor(Date.now() / 1000);

    const result = await env.DB.prepare(
      "INSERT INTO users (username, email, password, created_at) VALUES (?, ?, ?, ?) RETURNING id"
    ).bind(username, email, hashedPassword, now).first();

    const defaultDomain = username.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\-]/g, '').slice(0, 15);
    await env.DB.prepare(`
      INSERT INTO user_settings (user_id, website_domain, key_domain, encode_key, linkvertise_token, discord_webhook, ad_steps, step1_link, step2_link, created_at, updated_at)
      VALUES (?, ?, 'KEY', 'ntt-hub', '', '', 1, '', '', ?, ?)
      ON CONFLICT(user_id) DO NOTHING
    `).bind(result.id, defaultDomain, now, now).run();

    const token = await generateToken(result.id, username);

    return json({
      success: true,
      message: "Account created",
      user: { id: result.id, username, email },
      token,
    }, 201, request);
  }

  if (type === "login") {
    let body;
    try { body = await request.json(); }
    catch { return json({ success: false, error: "Invalid JSON" }, 400, request); }

    const { username, password } = body;
    if (!username || !password)
      return json({ success: false, error: "Username and password required" }, 400, request);

    const user = await env.DB.prepare("SELECT * FROM users WHERE username = ? OR email = ?")
      .bind(username, username).first();
    if (!user)
      return json({ success: false, error: "Invalid credentials" }, 401, request);

    const hashedInput = await hashPassword(password);
    if (hashedInput !== user.password)
      return json({ success: false, error: "Invalid credentials" }, 401, request);

    const token = await generateToken(user.id, user.username);

    return json({
      success: true,
      message: "Login successful",
      user: { id: user.id, username: user.username, email: user.email },
      token,
    }, request);
  }

  if (type === "verify") {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer "))
      return json({ success: false, error: "No token" }, 401, request);

    const token = authHeader.substring(7);
    const payload = await verifyToken(token);
    if (!payload)
      return json({ success: false, error: "Invalid token" }, 401, request);

    const user = await env.DB.prepare(
      "SELECT id, username, email, created_at FROM users WHERE id = ?"
    ).bind(payload.userId).first();

    if (!user)
      return json({ success: false, error: "User not found" }, 404, request);

    return json({
      success: true,
      user: { id: user.id, username: user.username, email: user.email, created_at: user.created_at },
    }, request);
  }

  if (type === "save_settings") {
    let body;
    try { body = await request.json(); }
    catch { return json({ success: false, error: "Invalid JSON" }, 400, request); }

    const {
      user_id, website_domain, key_domain, encode_key,
      linkvertise_token, discord_webhook, ad_steps,
      step1_link, step2_link, step1_type, step2_type,
      step1_yt_links, step2_yt_links,
    } = body;

    if (!user_id || !website_domain)
      return json({ success: false, error: "Missing required fields" }, 400, request);

    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer '))
      return json({ success: false, error: 'Unauthorized' }, 401, request);
    const authPayload = await verifyToken(authHeader.slice(7));
    if (!authPayload)
      return json({ success: false, error: 'Invalid or expired token' }, 401, request);
    if (String(authPayload.userId) !== String(user_id))
      return json({ success: false, error: 'Forbidden' }, 403, request);



    const finalDomain = website_domain
      .trim().toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9\-]/g, "")
      .slice(0, 15);

    if (!finalDomain)
      return json({ success: false, error: "Invalid website domain" }, 400, request);

    const finalKeyDomain = (key_domain || "KEY").toUpperCase();
    if (finalKeyDomain.length > 10)
      return json({ success: false, error: "Key domain max 10 chars" }, 400, request);

    const now            = Math.floor(Date.now() / 1000);
    const finalEncodeKey = encode_key || "ntt-hub";
    if (finalEncodeKey.length > 20)
      return json({ success: false, error: "Encode key max 20 chars" }, 400, request);

    const domainTaken = await env.DB.prepare(
      "SELECT user_id FROM user_settings WHERE website_domain = ? AND user_id != ?"
    ).bind(finalDomain, user_id).first();
    if (domainTaken)
      return json({ success: false, error: "Domain already taken by another user" }, 409, request);

    const existing = await env.DB.prepare("SELECT * FROM user_settings WHERE user_id = ?")
      .bind(user_id).first();

    const finalToken     = linkvertise_token !== undefined ? linkvertise_token : (existing?.linkvertise_token || "");
    const finalWebhook   = discord_webhook   !== undefined ? discord_webhook   : (existing?.discord_webhook   || "");
    const finalSteps     = ad_steps          !== undefined ? ad_steps          : (existing?.ad_steps          || 1);
    const finalStep1     = step1_link        !== undefined ? step1_link        : (existing?.step1_link        || "");
    const finalStep2     = step2_link        !== undefined ? step2_link        : (existing?.step2_link        || "");
    const finalStep1Type  = step1_type       !== undefined ? step1_type       : (existing?.step1_type       || "linkvertise");
    const finalStep2Type  = step2_type       !== undefined ? step2_type       : (existing?.step2_type       || "linkvertise");
    const finalStep1Yt    = step1_yt_links   !== undefined ? step1_yt_links   : (existing?.step1_yt_links   || "[]");
    const finalStep2Yt    = step2_yt_links   !== undefined ? step2_yt_links   : (existing?.step2_yt_links   || "[]");

    await env.DB.prepare(`
      INSERT INTO user_settings
        (user_id, website_domain, key_domain, encode_key, linkvertise_token, discord_webhook, ad_steps, step1_link, step2_link, step1_type, step2_type, step1_yt_links, step2_yt_links, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        website_domain    = excluded.website_domain,
        key_domain        = excluded.key_domain,
        encode_key        = excluded.encode_key,
        linkvertise_token = excluded.linkvertise_token,
        discord_webhook   = excluded.discord_webhook,
        ad_steps          = excluded.ad_steps,
        step1_link        = excluded.step1_link,
        step2_link        = excluded.step2_link,
        step1_type        = excluded.step1_type,
        step2_type        = excluded.step2_type,
        step1_yt_links    = excluded.step1_yt_links,
        step2_yt_links    = excluded.step2_yt_links,
        updated_at        = excluded.updated_at
    `).bind(
      user_id, finalDomain, finalKeyDomain, finalEncodeKey,
      finalToken, finalWebhook, finalSteps,
      finalStep1, finalStep2, finalStep1Type, finalStep2Type,
      finalStep1Yt, finalStep2Yt, now, now,
    ).run();

    return json({ success: true, message: "Settings saved", website_domain: finalDomain }, request);
  }

  if (type === "get_settings") {
    const userId = url.searchParams.get("user_id");
    if (!userId) return json({ success: false, error: "Missing user_id" }, 400, request);

    const authHeader = request.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer "))
      return json({ success: false, error: "Unauthorized" }, 401, request);
    const authPayload = await verifyToken(authHeader.slice(7));
    if (!authPayload)
      return json({ success: false, error: "Invalid or expired token" }, 401, request);
    if (String(authPayload.userId) !== String(userId))
      return json({ success: false, error: "Forbidden" }, 403, request);

    const settings = await env.DB.prepare("SELECT * FROM user_settings WHERE user_id = ?")
      .bind(userId).first();

    if (!settings)
      return json({ success: false, error: "Settings not found" }, 404, request);

    return json({ success: true, settings: {
      ...settings,
      captcha_type:      settings.captcha_type      || "text",
      captcha_lockout:   settings.captcha_lockout   ?? 1,
      best_time_enabled: settings.best_time_enabled ?? 0,
    } }, request);
  }

  if (type === "get_flows") {
    const userId = url.searchParams.get("user_id");
    if (!userId) return json({ success: false, error: "Missing user_id" }, 400, request);
    const auth = await requireAuthUser(request, userId);
    if (auth.response) return auth.response;
    const flows = await env.DB.prepare("SELECT * FROM user_flows WHERE user_id = ? ORDER BY flow_id ASC").bind(userId).all();
    return json({ success: true, flows: flows.results || [] }, request);
  }

  if (type === "save_flow") {
    let body;
    try { body = await request.json(); }
    catch { return json({ success: false, error: "Invalid JSON" }, 400, request); }
    const { user_id, flow_id, ad_steps } = body;
    if (!user_id || !flow_id) return json({ success: false, error: "Missing params" }, 400, request);
    const auth = await requireAuthUser(request, user_id);
    if (auth.response) return auth.response;
    const safeSteps = clampAdSteps(ad_steps);
    const forcedName = `Flow ${flow_id}`;
    const now = Math.floor(Date.now() / 1000);
    const stepValues = [];
    for (let i = 1; i <= MAX_FLOW_STEPS; i++) {
      stepValues.push(body[`step${i}_type`] || "linkvertise");
      stepValues.push(body[`step${i}_link`] || "");
      stepValues.push(body[`step${i}_yt_links`] || "[]");
    }
    await env.DB.prepare(`
      INSERT INTO user_flows (user_id, flow_id, name, ad_steps, step1_type, step1_link, step1_yt_links, step2_type, step2_link, step2_yt_links, step3_type, step3_link, step3_yt_links, step4_type, step4_link, step4_yt_links, step5_type, step5_link, step5_yt_links, step6_type, step6_link, step6_yt_links, step7_type, step7_link, step7_yt_links, step8_type, step8_link, step8_yt_links, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, flow_id) DO UPDATE SET
        name           = excluded.name,
        ad_steps       = excluded.ad_steps,
        step1_type     = excluded.step1_type,
        step1_link     = excluded.step1_link,
        step1_yt_links = excluded.step1_yt_links,
        step2_type     = excluded.step2_type,
        step2_link     = excluded.step2_link,
        step2_yt_links = excluded.step2_yt_links,
        step3_type     = excluded.step3_type,
        step3_link     = excluded.step3_link,
        step3_yt_links = excluded.step3_yt_links,
        step4_type     = excluded.step4_type,
        step4_link     = excluded.step4_link,
        step4_yt_links = excluded.step4_yt_links,
        step5_type     = excluded.step5_type,
        step5_link     = excluded.step5_link,
        step5_yt_links = excluded.step5_yt_links,
        step6_type     = excluded.step6_type,
        step6_link     = excluded.step6_link,
        step6_yt_links = excluded.step6_yt_links,
        step7_type     = excluded.step7_type,
        step7_link     = excluded.step7_link,
        step7_yt_links = excluded.step7_yt_links,
        step8_type     = excluded.step8_type,
        step8_link     = excluded.step8_link,
        step8_yt_links = excluded.step8_yt_links,
        updated_at     = excluded.updated_at
    `).bind(user_id, String(flow_id), forcedName, safeSteps, ...stepValues, now, now).run();
    try { await env.DB.prepare("UPDATE key_daily_stats SET flow_name = ? WHERE user_id = ? AND flow_id = ?").bind(forcedName, user_id, String(flow_id)).run(); } catch {}
    return json({ success: true, message: "Flow saved", flow: { flow_id: String(flow_id), name: forcedName, ad_steps: safeSteps } }, request);
  }

  if (type === "delete_flow") {
    let body;
    try { body = await request.json(); }
    catch { return json({ success: false, error: "Invalid JSON" }, 400, request); }

    const { user_id, flow_id } = body;
    if (!user_id || !flow_id) return json({ success: false, error: "Missing params" }, 400, request);

    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer '))
      return json({ success: false, error: 'Unauthorized' }, 401, request);
    const authPayload = await verifyToken(authHeader.slice(7));
    if (!authPayload)
      return json({ success: false, error: 'Invalid or expired token' }, 401, request);
    if (String(authPayload.userId) !== String(user_id))
      return json({ success: false, error: 'Forbidden' }, 403, request);

    await env.DB.prepare("DELETE FROM key_links WHERE user_id = ? AND flow_id = ?").bind(user_id, String(flow_id)).run();
    await env.DB.prepare("DELETE FROM shorturl_items WHERE user_id = ? AND flow_id = ?").bind(user_id, String(flow_id)).run();
    await env.DB.prepare("DELETE FROM user_flows WHERE user_id = ? AND flow_id = ?").bind(user_id, flow_id).run();
    return json({ success: true, message: "Flow deleted" }, request);
  }


  if (type === "get_key_links") {
    const userId = url.searchParams.get("user_id");
    if (!userId) return json({ success: false, error: "Missing user_id" }, 400, request);
    const auth = await requireAuthUser(request, userId);
    if (auth.response) return auth.response;

    const rows = await env.DB.prepare(`
      SELECT item_id AS id, name, flow_id, key_duration, created_at, updated_at
      FROM key_links
      WHERE user_id = ?
      ORDER BY item_id ASC
    `).bind(userId).all();
    return json({ success: true, items: rows.results || [] }, request);
  }

  if (type === "save_key_link") {
    let body;
    try { body = await request.json(); }
    catch { return json({ success: false, error: "Invalid JSON" }, 400, request); }

    const { user_id, id, name, flow_id, key_duration } = body;
    if (!user_id || !flow_id) return json({ success: false, error: "Missing params" }, 400, request);
    const auth = await requireAuthUser(request, user_id);
    if (auth.response) return auth.response;

    const flow = await env.DB.prepare("SELECT flow_id FROM user_flows WHERE user_id = ? AND flow_id = ?")
      .bind(user_id, String(flow_id)).first();
    if (!flow) return json({ success: false, error: "Flow not found" }, 404, request);

    let itemId = Number(id || 0);
    if (!itemId) {
      const next = await env.DB.prepare("SELECT COALESCE(MAX(item_id), 0) + 1 AS next_id FROM key_links WHERE user_id = ?")
        .bind(user_id).first();
      itemId = Number(next?.next_id || 1);
    }

    const now = Math.floor(Date.now() / 1000);
    const safeName = normalizeItemName(name, `Key ${itemId}`);
    const safeDuration = safeKeyDuration(key_duration);

    await env.DB.prepare(`
      INSERT INTO key_links (user_id, item_id, name, flow_id, key_duration, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, item_id) DO UPDATE SET
        name         = excluded.name,
        flow_id      = excluded.flow_id,
        key_duration = excluded.key_duration,
        updated_at   = excluded.updated_at
    `).bind(user_id, itemId, safeName, String(flow_id), safeDuration, now, now).run();

    return json({ success: true, item: { id: itemId, name: safeName, flow_id: String(flow_id), key_duration: safeDuration, created_at: now, updated_at: now } }, request);
  }

  if (type === "delete_key_link") {
    let body;
    try { body = await request.json(); }
    catch { return json({ success: false, error: "Invalid JSON" }, 400, request); }

    const { user_id, id } = body;
    if (!user_id || !id) return json({ success: false, error: "Missing params" }, 400, request);
    const auth = await requireAuthUser(request, user_id);
    if (auth.response) return auth.response;

    await env.DB.prepare("DELETE FROM key_links WHERE user_id = ? AND item_id = ?")
      .bind(user_id, id).run();
    return json({ success: true, message: "Key link deleted" }, request);
  }

  if (type === "get_shorturl_items") {
    const userId = url.searchParams.get("user_id");
    if (!userId) return json({ success: false, error: "Missing user_id" }, 400, request);
    const auth = await requireAuthUser(request, userId);
    if (auth.response) return auth.response;

    const rows = await env.DB.prepare(`
      SELECT item_id AS id, name, flow_id, final_url, created_at, updated_at
      FROM shorturl_items
      WHERE user_id = ?
      ORDER BY item_id ASC
    `).bind(userId).all();
    return json({ success: true, items: rows.results || [] }, request);
  }

  if (type === "save_shorturl_item") {
    let body;
    try { body = await request.json(); }
    catch { return json({ success: false, error: "Invalid JSON" }, 400, request); }

    const { user_id, id, name, flow_id, final_url } = body;
    if (!user_id || !flow_id || !final_url) return json({ success: false, error: "Missing params" }, 400, request);
    const auth = await requireAuthUser(request, user_id);
    if (auth.response) return auth.response;
    if (!isHttpUrl(final_url)) return json({ success: false, error: "Invalid final URL" }, 400, request);

    const flow = await env.DB.prepare("SELECT flow_id FROM user_flows WHERE user_id = ? AND flow_id = ?")
      .bind(user_id, String(flow_id)).first();
    if (!flow) return json({ success: false, error: "Flow not found" }, 404, request);

    let itemId = Number(id || 0);
    if (!itemId) {
      const next = await env.DB.prepare("SELECT COALESCE(MAX(item_id), 0) + 1 AS next_id FROM shorturl_items WHERE user_id = ?")
        .bind(user_id).first();
      itemId = Number(next?.next_id || 1);
    }

    const now = Math.floor(Date.now() / 1000);
    const safeName = normalizeItemName(name, `ShortUrl ${itemId}`);

    await env.DB.prepare(`
      INSERT INTO shorturl_items (user_id, item_id, name, flow_id, final_url, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, item_id) DO UPDATE SET
        name       = excluded.name,
        flow_id    = excluded.flow_id,
        final_url  = excluded.final_url,
        updated_at = excluded.updated_at
    `).bind(user_id, itemId, safeName, String(flow_id), final_url, now, now).run();

    return json({ success: true, item: { id: itemId, name: safeName, flow_id: String(flow_id), final_url, created_at: now, updated_at: now } }, request);
  }

  if (type === "delete_shorturl_item") {
    let body;
    try { body = await request.json(); }
    catch { return json({ success: false, error: "Invalid JSON" }, 400, request); }

    const { user_id, id } = body;
    if (!user_id || !id) return json({ success: false, error: "Missing params" }, 400, request);
    const auth = await requireAuthUser(request, user_id);
    if (auth.response) return auth.response;

    await env.DB.prepare("DELETE FROM shorturl_items WHERE user_id = ? AND item_id = ?")
      .bind(user_id, id).run();
    return json({ success: true, message: "ShortUrl deleted" }, request);
  }

  if (type === "get_shorturl_public") {
    const domain = url.searchParams.get("domain");
    const id     = url.searchParams.get("id");
    if (!domain || !id) return json({ success: false, error: "Missing params" }, 400, request);

    const settings = await env.DB.prepare("SELECT user_id, website_domain FROM user_settings WHERE website_domain = ?")
      .bind(domain).first();
    if (!settings) return json({ success: false, error: "Settings not found" }, 404, request);

    const item = await env.DB.prepare(`
      SELECT item_id AS id, name, flow_id, created_at, updated_at
      FROM shorturl_items
      WHERE user_id = ? AND item_id = ?
    `).bind(settings.user_id, id).first();
    if (!item) return json({ success: false, error: "ShortUrl not found" }, 404, request);

    return json({ success: true, item }, request);
  }

  if (type === "resolve_shorturl") {
    const domain = url.searchParams.get("domain");
    const id     = url.searchParams.get("id");
    let hwid     = normalizeHwid(url);
    if (!domain || !id || !hwid) return json({ success: false, error: "Missing params" }, 400, request);

    const settings = await env.DB.prepare("SELECT * FROM user_settings WHERE website_domain = ?")
      .bind(domain).first();
    if (!settings) return json({ success: false, error: "Settings not found" }, 404, request);

    const item = await env.DB.prepare("SELECT * FROM shorturl_items WHERE user_id = ? AND item_id = ?")
      .bind(settings.user_id, id).first();
    if (!item) return json({ success: false, error: "ShortUrl not found" }, 404, request);

    const flowKey = String(item.flow_id || "default");
    const progress = await env.DB.prepare("SELECT * FROM progress WHERE hwid = ? AND flow_id = ?")
      .bind(hwid, flowKey).first();
    if (!progress) return json({ success: false, error: "No progress found. Please complete the steps." }, 403, request);

    let adSteps = 1;
    const flow = await env.DB.prepare("SELECT ad_steps FROM user_flows WHERE user_id = ? AND flow_id = ?")
      .bind(settings.user_id, flowKey).first();
    if (flow) adSteps = clampAdSteps(flow.ad_steps || 1);
    for (let i = 1; i <= adSteps; i++) {
      if (!progress[`step${i}`]) return json({ success: false, error: `Step ${i} not completed` }, 403, request);
    }

    const now = Math.floor(Date.now() / 1000);
    await recordAdsComplete(env, settings.user_id, "shorturl", item.item_id || id, item.name || `ShortUrl ${id}`, now);

    await env.DB.prepare("DELETE FROM progress WHERE hwid = ? AND flow_id = ?").bind(hwid, flowKey).run();
    return json({ success: true, final_url: item.final_url }, request);
  }

  if (type === "get_settings_by_domain") {
    const domain = url.searchParams.get("domain");
    let flowId   = url.searchParams.get("flow");
    const keyId  = url.searchParams.get("id") || url.searchParams.get("key_id");
    if (!domain) return json({ success: false, error: "Missing domain" }, 400, request);
    const settings = await env.DB.prepare("SELECT * FROM user_settings WHERE website_domain = ?").bind(domain).first();
    if (!settings) return json({ success: false, error: "Settings not found" }, 404, request);
    let keyItem = null;
    if (keyId) {
      keyItem = await env.DB.prepare(`SELECT item_id AS id, name, flow_id, key_duration FROM key_links WHERE user_id = ? AND item_id = ?`).bind(settings.user_id, keyId).first();
      if (!keyItem) return json({ success: false, error: "key_link_not_found" }, 404, request);
      flowId = keyItem.flow_id;
    }
    const sys = await env.DB.prepare("SELECT * FROM system_settings WHERE id = 1").first();
    let flowSettings = {};
    if (flowId) {
      const flow = await env.DB.prepare("SELECT * FROM user_flows WHERE user_id = ? AND flow_id = ?").bind(settings.user_id, flowId).first();
      if (flow) {
        flowSettings = { ad_steps: clampAdSteps(flow.ad_steps), flow_id: String(flowId) };
        for (let i = 1; i <= MAX_FLOW_STEPS; i++) {
          flowSettings[`step${i}_type`] = stepTypeValue(flow, i);
          flowSettings[`step${i}_link`] = stepValue(flow, i, 'link', '');
          flowSettings[`step${i}_yt_links`] = stepValue(flow, i, 'yt_links', '[]');
        }
      } else if (keyId) return json({ success: false, error: "flow_not_found" }, 404, request);
    }
    const outSettings = {
      website_domain: settings.website_domain,
      key_domain: settings.key_domain,
      ad_steps: clampAdSteps(settings.ad_steps),
      captcha_type: settings.captcha_type || "text",
      key_item: keyItem,
      key_duration: keyItem ? safeKeyDuration(keyItem.key_duration) : undefined,
      start_link: sys?.start_link || env.SYSTEM_START_LINK || "",
      start_type: sys?.start_type || "linkvertise",
      start_yt_links: sys?.start_yt_links || "[]",
    };
    for (let i = 1; i <= MAX_FLOW_STEPS; i++) {
      outSettings[`step${i}_type`] = stepTypeValue(settings, i);
      outSettings[`step${i}_link`] = stepValue(settings, i, 'link', '');
      outSettings[`step${i}_yt_links`] = stepValue(settings, i, 'yt_links', '[]');
    }
    Object.assign(outSettings, flowSettings);
    return json({ success: true, settings: outSettings }, request);
  }

  if (type === "change_username") {
    let body;
    try { body = await request.json(); }
    catch { return json({ success: false, error: "Invalid JSON" }, 400, request); }

    const { user_id, new_username, password } = body;
    if (!user_id || !new_username || !password)
      return json({ success: false, error: "Missing parameters" }, 400, request);

    if (!/^[a-zA-Z0-9_ ]+$/.test(new_username))
      return json({ success: false, error: "Username can only contain letters, numbers, spaces, and underscores" }, 400, request);

    if (new_username.length < 3 || new_username.length > 15)
      return json({ success: false, error: "Username must be 3-15 chars" }, 400, request);

    const userCheck = await env.DB.prepare("SELECT password FROM users WHERE id = ?")
      .bind(user_id).first();
    if (!userCheck) return json({ success: false, error: "User not found" }, 404, request);

    const hashedInput = await hashPassword(password);
    if (hashedInput !== userCheck.password)
      return json({ success: false, error: "Incorrect password" }, 401, request);

    const existing = await env.DB.prepare("SELECT id FROM users WHERE username = ? AND id != ?")
      .bind(new_username, user_id).first();
    if (existing)
      return json({ success: false, error: "Username already taken" }, 409, request);

    await env.DB.prepare("UPDATE users SET username = ? WHERE id = ?")
      .bind(new_username, user_id).run();

    return json({ success: true, message: "Username updated" }, request);
  }

  if (type === "change_password") {
    let body;
    try { body = await request.json(); }
    catch { return json({ success: false, error: "Invalid JSON" }, 400, request); }

    const { user_id, current_password, new_password } = body;
    if (!user_id || !current_password || !new_password)
      return json({ success: false, error: "Missing parameters" }, 400, request);

    if (new_password.length < 6 || new_password.length > 20)
      return json({ success: false, error: "Password must be 6-20 chars" }, 400, request);

    const user = await env.DB.prepare("SELECT password FROM users WHERE id = ?")
      .bind(user_id).first();
    if (!user)
      return json({ success: false, error: "User not found" }, 404, request);

    const hashedCurrent = await hashPassword(current_password);
    if (hashedCurrent !== user.password)
      return json({ success: false, error: "Current password is incorrect" }, 401, request);

    const hashedNew = await hashPassword(new_password);
    await env.DB.prepare("UPDATE users SET password = ? WHERE id = ?")
      .bind(hashedNew, user_id).run();

    return json({ success: true, message: "Password updated" }, request);
  }

  if (type === "get_system_total") {
    try {
      const result = await env.DB.prepare("SELECT SUM(total_keys) as total FROM user_settings").first();
      return json({ success: true, total: result?.total || 0 }, request);
    } catch {
      return json({ success: true, total: 0 }, request);
    }
  }

  if (type === "get_stats") {
    try {
      const keysRow  = await env.DB.prepare("SELECT SUM(total_keys) as total FROM user_settings").first();
      const usersRow = await env.DB.prepare("SELECT COUNT(*) as total FROM users").first();
      return json({
        success:     true,
        total_keys:  keysRow?.total  || 0,
        total_users: usersRow?.total || 0,
      }, request);
    } catch {
      return json({ success: true, total_keys: 0, total_users: 0 }, request);
    }
  }

  if (type === "get_ads_stats") {
    const userId = url.searchParams.get("user_id");
    if (!userId) return json({ success: false, error: "Missing user_id" }, 400, request);

    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer '))
      return json({ success: false, error: 'Unauthorized' }, 401, request);
    const authPayload = await verifyToken(authHeader.slice(7));
    if (!authPayload)
      return json({ success: false, error: 'Invalid or expired token' }, 401, request);
    if (String(authPayload.userId) !== String(userId))
      return json({ success: false, error: 'Forbidden' }, 403, request);

    const now     = Math.floor(Date.now() / 1000);
    const todayTs = now - (now % 86400);

    try {
      await env.DB.prepare("DELETE FROM ads_daily_stats WHERE user_id = ? AND day_ts < ?")
        .bind(userId, todayTs - 31 * 86400).run();
    } catch {}

    const since7 = todayTs - 6 * 86400;
    try {
      const rows = await env.DB.prepare(
        "SELECT day_ts, item_type, item_id, item_name, count FROM ads_daily_stats WHERE user_id = ? AND day_ts >= ? ORDER BY day_ts ASC, item_type ASC, item_id ASC"
      ).bind(userId, since7).all();

      const totalRow = await env.DB.prepare(
        "SELECT COALESCE(SUM(count), 0) AS total FROM ads_daily_stats WHERE user_id = ?"
      ).bind(userId).first();

      const total7 = (rows.results || []).reduce((s, r) => s + (r.count || 0), 0);
      return json({ success: true, rows: rows.results || [], total7, total_all: totalRow?.total || 0 }, request);
    } catch (e) {
      return json({ success: false, error: "ads_stats_table_missing", message: "Run the ads_daily_stats SQL migration." }, 500, request);
    }
  }

  if (type === "get_key_stats") {
    const userId = url.searchParams.get("user_id");
    if (!userId) return json({ success: false, error: "Missing user_id" }, 400, request);

    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer '))
      return json({ success: false, error: 'Unauthorized' }, 401, request);
    const authPayload = await verifyToken(authHeader.slice(7));
    if (!authPayload)
      return json({ success: false, error: 'Invalid or expired token' }, 401, request);
    if (String(authPayload.userId) !== String(userId))
      return json({ success: false, error: 'Forbidden' }, 403, request);

    const now     = Math.floor(Date.now() / 1000);
    const todayTs = now - (now % 86400);

    try {
      await env.DB.prepare("DELETE FROM key_daily_stats WHERE user_id = ? AND day_ts < ?")
        .bind(userId, todayTs - 8 * 86400).run();
    } catch {}

    const since7 = todayTs - 6 * 86400;
    const rows = await env.DB.prepare(
      "SELECT day_ts, flow_id, flow_name, count FROM key_daily_stats WHERE user_id = ? AND day_ts >= ? ORDER BY day_ts ASC"
    ).bind(userId, since7).all();

    const total7 = (rows.results || []).reduce((s, r) => s + (r.count || 0), 0);
    return json({ success: true, rows: rows.results || [], total7 }, request);
  }

  return json({ status: false, error: "invalid_type" }, 400, request);
}
