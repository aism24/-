# 手順書PDFの作成スクリプト(tdf-dim-count)。使い方は README.md を参照
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4, landscape
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.utils import ImageReader
from reportlab.lib.colors import HexColor, white
pdfmetrics.registerFont(TTFont('J','/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf'))
import os
HERE=os.path.dirname(os.path.abspath(__file__))
M=HERE+'/media/image%d.png'
W,H=landscape(A4)
BLUE=HexColor('#4f46c8'); GRAY=HexColor('#555555'); RED=HexColor('#c0392b')
pages=[
 dict(step='STEP 1',part='実寸法師で準備する',title='集計したい図面(TDF)を開く',
  body=['実寸法師を起動し、長さと本数を集計したい図面(TDFファイル)を開きます。'],imgs=[[1]]),
 dict(step='STEP 2',part='実寸法師で準備する',title='集計用のレイヤを新しく作る',
  body=['①「図面」→「レイヤ」から「レイヤ名一覧」を開き、画面下の「C/作成」を押します。',
        '②「レイヤ名設定」で、ほかのレイヤとかぶらない名前を入力し、「OK」を押します。',
        'おすすめ: 部材のサイズ(例: L-75x75x6)にすると、Excelで見たとき何の寸法か分かりやすくなります。',
        '※ すでにあるレイヤ名と同じ名前は使えません。'],imgs=[[2,3]]),
 dict(step='STEP 3',part='実寸法師で準備する',title='寸法の入力方法とレイヤを設定する',
  body=['①画面右の機能メニューで、「寸法」→「距離」→「2点間」の順に選びます。',
        '②「条件」の「レイヤ」欄を押して、STEP 2 で作ったレイヤを選びます。',
        '③「条件」欄のレイヤが、作ったレイヤになっていることを確認します。',
        'サイズは分かりやすいように 1000 にしています(サイズや色は、見やすければ何でも構いません)。'],imgs=[[4,5,6]]),
 dict(step='STEP 6',part='実寸法師で準備する',title='集計したい長さを寸法で作図して保存',
  body=['集計したい部材の長さを、2点間の寸法で1本ずつ作図します(寸法の数字が表示されます)。',
        '作図が終わったら、ファイルを保存します。'],imgs=[[7]]),
 dict(step='STEP 6',part='アプリで集計する',title='アプリを開いて、TDFを取り込む',
  body=['①ブラウザで集計アプリ「実寸データより長さと本数集計」を開きます。  URL: https://tdf-dim-count.vercel.app/',
        '②STEP 4 で保存したTDFファイルを、次のどちらかで取り込みます。',
        '　・ファイルを画面にドラッグ&ドロップする(画面のどこでもOK)',
        '　・「フォルダを開く」を押して、ファイルを選ぶ'],imgs=[[8,9]]),
 dict(step='STEP 7',part='アプリで集計する',title='レイヤを選んで、長さと本数を確認する',
  body=['①「② レイヤをリストから選ぶ」を押して、STEP 2 で作ったレイヤ(例: L-75x75x6)を選びます。',
        '②「③ 集計テーブル」に、寸法(長さ)ごとの本数が表示されます。',
        '長さを「まとめる」場合は、上のボタン(±10 / ±20 / ±30)を選びます。'],imgs=[[10,11]]),
 dict(step='STEP 8',part='アプリで集計する',title='Excelでダウンロードして開く',
  body=['①画面左上の緑色の「Excelダウンロード」を押します。パソコンの「ダウンロード」フォルダに保存されます。',
        '②ダウンロードしたExcelを開くと、取り込んだ図面の指定レイヤの',
        '　「長さ(テキスト)」と「本数」が一覧になっています。'],imgs=[[12,13,14]]),
]
for _i,_p in enumerate(pages,1): _p['step']='STEP %d'%_i
c=canvas.Canvas(HERE+'/手順書_ドラフト.pdf',pagesize=(W,H))
c.setTitle('実寸データより長さと本数集計 手順書(ドラフト)')
# cover
c.setFillColor(HexColor('#fff3b0'));c.rect(0,H-110,W,110,fill=1,stroke=0)
lw=190;c.drawImage(HERE+'/logo.png',W-30-lw,H-110+(110-lw*400/1192)/2,lw,lw*400/1192,mask='auto')
c.setFillColor(HexColor('#222222'));c.setFont('J',36);c.drawString(40,H-60,'実寸データより長さと本数集計')
c.setFillColor(HexColor('#444444'));c.setFont('J',20);c.drawString(40,H-92,'使い方 手順書')
c.setFillColor(HexColor('#222222'));c.setFont('J',17)
c.drawString(40,H-145,'各種ブレース、二次部材、胴縁など実寸の寸法データを抽出するアプリです。')
c.setFont('J',14);c.setFillColor(GRAY)
c.drawString(40,H-170,'実寸法師のデータ(TDF)から、指定した寸法の「長さ」と「本数」を集計し、Excelにまとめます。')
parts=[('A','実寸法師で準備する','集計したい寸法だけを、専用のレイヤに作図して保存します',pages[:4],HexColor('#e8f0fe'),BLUE),
       ('B','アプリで集計する','保存したTDFを取り込み、レイヤを選んでExcelにします',pages[4:],HexColor('#e6f4ea'),HexColor('#1e8449'))]
bw=(W-80-40)/2;top=H-195;bh=top-45
for i,(k,t,d,ps,bg,fg) in enumerate(parts):
    x=40+i*(bw+40)
    c.setFillColor(bg);c.roundRect(x,45,bw,bh,10,fill=1,stroke=0)
    c.setFillColor(fg);c.roundRect(x,top-40,bw,40,10,fill=1,stroke=0);c.rect(x,top-40,bw,15,fill=1,stroke=0)
    c.setFillColor(white);c.setFont('J',18);c.drawString(x+16,top-28,'%s  %s'%(k,t))
    c.setFillColor(GRAY);c.setFont('J',11);c.drawString(x+16,top-62,d)
    yy=top-92
    for p in ps:
        c.setFillColor(fg);c.roundRect(x+16,yy-6,64,22,5,fill=1,stroke=0)
        c.setFillColor(white);c.setFont('J',11);c.drawCentredString(x+48,yy+1,p['step'])
        c.setFillColor(HexColor('#222222'));c.setFont('J',14);c.drawString(x+92,yy,p["title"])
        yy-=44
    if i==0:
        c.setFillColor(BLUE);c.setFont('J',30);c.drawCentredString(x+bw+20,45+bh/2-10,'▶')
c.setFont('J',10);c.setFillColor(GRAY);c.drawString(30,20,'1');c.showPage()
for n,p in enumerate(pages,start=2):
    c.setFillColor(HexColor('#fff3b0'));c.rect(0,H-56,W,56,fill=1,stroke=0)
    c.setFillColor(HexColor('#444444'));c.setFont('J',13);c.drawString(30,H-22,p['part'])
    c.setFillColor(HexColor('#222222'));c.setFont('J',24);c.drawString(30,H-47,p['step']+'  '+p['title'])
    y=H-85;c.setFillColor(HexColor('#222222'));c.setFont('J',14)
    for t in p['body']:
        c.setFillColor(RED if t.startswith('※') else HexColor('#222222'));c.drawString(30,y,t);y-=22
    top=y-6;bottom=40;avail=top-bottom
    row=p['imgs'][0];ims=[ImageReader(M%i) for i in row]
    gap=20;sizes=[im.getSize() for im in ims]
    s=min(avail/max(h for w,h in sizes),(W-60-gap*(len(ims)-1))/sum(w for w,h in sizes))
    tw=sum(w*s for w,h in sizes)+gap*(len(ims)-1);x=(W-tw)/2
    if row==[4,5,6]:
        hh=avail-40;caps=['①','②','③ 設定を確認']
        ws=[im.getSize()[0]*hh/im.getSize()[1] for im in ims];tw=sum(ws)+60*2;xx=(W-tw)/2
        for im,ww,cp in zip(ims,ws,['① 機能を選ぶ','② レイヤを選ぶ','③ 設定を確認']):
            c.drawImage(im,xx,top-hh,ww,hh);c.setStrokeColor(HexColor('#999999'));c.rect(xx,top-hh,ww,hh,fill=0)
            c.setFillColor(RED);c.setFont('J',13);c.drawCentredString(xx+ww/2,top-hh-20,cp);xx+=ww+60
    elif row==[12,13,14]:
        def put(im,xx,yy,ww):
            w,h=im.getSize();hh=ww*h/w
            c.drawImage(im,xx,yy-hh,ww,hh);c.setStrokeColor(HexColor('#999999'));c.rect(xx,yy-hh,ww,hh,fill=0);return hh
        c.setFillColor(RED);c.setFont('J',13)
        c.drawString(30,top-8,'① ダウンロードする')
        h1=put(ims[0],30,top-20,400)
        c.setFillColor(RED);c.setFont('J',12);c.drawString(30,top-20-h1-18,'↓ 保存されたExcelファイル')
        put(ims[1],30,top-20-h1-28,260)
        c.setFont('J',13);c.drawString(460,top-8,'② Excelを開く')
        put(ims[2],460,top-20,W-30-460)
    elif row==[2,3]:
        w3=300;w2=W-60-gap-w3;h2=w2*sizes[0][1]/sizes[0][0];h3=w3*sizes[1][1]/sizes[1][0]
        for im,xx,ww,hh in ((ims[0],30,w2,h2),(ims[1],30+w2+gap,w3,h3)):
            c.drawImage(im,xx,top-hh,ww,hh);c.setStrokeColor(HexColor('#999999'));c.rect(xx,top-hh,ww,hh,fill=0)
        c.setFillColor(RED);c.setFont('J',12);c.drawString(30+w2+gap,top-h3-18,'↑ この画面に名前を入力します')
    else:
      for im,(w,h) in zip(ims,sizes):
        c.drawImage(im,x,top-h*s,w*s,h*s);c.setStrokeColor(HexColor('#999999'));c.rect(x,top-h*s,w*s,h*s,fill=0);x+=w*s+gap
    if n==len(pages)+1:
        c.setFillColor(HexColor('#fff8d6'));c.setStrokeColor(HexColor('#e0b800'));c.roundRect(30,34,W-60,34,6,fill=1,stroke=1)
        c.setFillColor(HexColor('#222222'));c.setFont('J',15);c.drawString(44,46,'サイズごとでレイヤ分けをするとサイズごとの抽出結果をダウンロードできます')
    c.setFillColor(GRAY);c.setFont('J',10);c.drawRightString(W-30,20,str(n));c.showPage()
c.save()
