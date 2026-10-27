// 血液検査記録: スプレッドシートにバインドしたGAS
//  setup()  … シート整備(記録・項目マスタ)と、PDF(R6〜R8)の結果の記録。エディタから1回だけ実行する
//  doGet/doPost … 記録の追加・一覧(撮影アプリ用)
var CODE_VERSION = '2026-10-27-2';
var SHEET_RECORD = '記録';
var SHEET_MASTER = '項目マスタ';
var HEADERS = ['検査日', '到着時間', '区分', '項目名', '値', '定性', '単位', '基準下限', '基準上限', '判定', '備考', '元ファイル', 'ページ', '登録日時'];
var MASTER_HEADERS = ['表示順', '区分', '項目名', '単位', '基準下限', '基準上限', '良い方向', '腎臓重点', 'キー'];

// [キー, 区分, 項目名, 単位, 基準下限, 基準上限, 良い方向, 腎臓重点]
var MASTER = [
  ["TP", "生化学", "総蛋白", "g/dL", 6.6, 8.1, "基準内", ""],
  ["Alb", "生化学", "アルブミン", "g/dL", 4.1, 5.1, "高いほど良い", "◎"],
  ["AG", "生化学", "A/G", "", 1.32, 2.23, "基準内", ""],
  ["CRP", "生化学", "CRP", "mg/dL", 0.0, 0.14, "低いほど良い", ""],
  ["TBil", "生化学", "総ビリルビン", "mg/dL", 0.4, 1.5, "基準内", ""],
  ["DBil", "生化学", "直接ビリルビン", "mg/dL", 0.0, 0.3, "基準内", ""],
  ["AST", "生化学", "AST", "U/L", 13, 30, "基準内", ""],
  ["ALT", "生化学", "ALT", "U/L", 10, 42, "基準内", ""],
  ["ALP", "生化学", "ALP", "U/L", 38, 113, "基準内", ""],
  ["GGT", "生化学", "γ-GT", "U/L", 13, 64, "基準内", ""],
  ["LD", "生化学", "LD", "U/L", 124, 222, "基準内", ""],
  ["CK", "生化学", "CK", "U/L", 59, 248, "基準内", ""],
  ["Amy", "生化学", "アミラーゼ", "U/L", 44, 132, "基準内", ""],
  ["TC", "生化学", "総コレステロール", "mg/dL", 142, 220, "基準内", ""],
  ["HDL", "生化学", "HDL-C", "mg/dL", 38, 90, "高いほど良い", ""],
  ["LDL", "生化学", "LDL-C", "mg/dL", 65, 139, "基準内", ""],
  ["TG", "生化学", "中性脂肪", "mg/dL", 40, 149, "低いほど良い", ""],
  ["BUN", "腎・電解質", "尿素窒素", "mg/dL", 8.0, 20.0, "低いほど良い", "◎"],
  ["Cre", "腎・電解質", "クレアチニン", "mg/dL", 0.65, 1.07, "低いほど良い", "◎"],
  ["eGFR", "腎・電解質", "eGFR", "mL/min/1.73m²", 60, "", "高いほど良い", "◎"],
  ["UA", "腎・電解質", "尿酸", "mg/dL", 3.7, 7.8, "基準内", "◎"],
  ["Ca", "腎・電解質", "カルシウム", "mg/dL", 8.8, 10.1, "基準内", "◎"],
  ["cCa", "腎・電解質", "補正Ca", "mg/dL", "", "", "基準内", "◎"],
  ["IP", "腎・電解質", "無機リン", "mg/dL", 2.7, 4.6, "基準内", "◎"],
  ["Mg", "腎・電解質", "マグネシウム", "mg/dL", 1.8, 2.4, "基準内", ""],
  ["Na", "腎・電解質", "ナトリウム", "mmol/L", 138, 145, "基準内", "◎"],
  ["K", "腎・電解質", "カリウム", "mmol/L", 3.6, 4.8, "基準内", "◎"],
  ["Cl", "腎・電解質", "クロール", "mmol/L", 101, 108, "基準内", ""],
  ["Cu", "鉄・微量元素", "銅", "μg/dL", 66, 130, "基準内", ""],
  ["TSAT", "鉄・微量元素", "トランスフェリン飽和度", "%", "", "", "基準内", ""],
  ["Fe", "鉄・微量元素", "血清鉄", "μg/dL", 40, 188, "基準内", ""],
  ["UIBC", "鉄・微量元素", "不飽和鉄結合能", "μg/dL", 87, 261, "基準内", ""],
  ["Ferr", "鉄・微量元素", "フェリチン", "ng/mL", 12, 250, "基準内", ""],
  ["Zn", "鉄・微量元素", "亜鉛", "μg/dL", 80.0, 130.0, "基準内", ""],
  ["sHem", "血清性状", "血清-溶血", "", "", "", "", ""],
  ["sChy", "血清性状", "血清-乳び", "", "", "", "", ""],
  ["sYel", "血清性状", "血清-黄色", "", "", "", "", ""],
  ["Glu", "糖関連", "血糖", "mg/dL", 73, 109, "基準内", ""],
  ["A1c", "糖関連", "HbA1c(NGSP)", "%", 4.9, 6.0, "基準内", ""],
  ["WBC", "血液", "白血球数", "10^3/μL", 3.3, 8.6, "基準内", ""],
  ["RBC", "血液", "赤血球数", "10^6/μL", 4.35, 5.55, "基準内", "◎"],
  ["Hb", "血液", "ヘモグロビン", "g/dL", 13.7, 16.8, "基準内", "◎"],
  ["Ht", "血液", "ヘマトクリット", "%", 40.7, 50.1, "基準内", "◎"],
  ["MCV", "血液", "MCV", "fL", 83.6, 98.2, "基準内", ""],
  ["MCH", "血液", "MCH", "pg", 27.5, 33.2, "基準内", ""],
  ["MCHC", "血液", "MCHC", "g/dL", 31.7, 35.3, "基準内", ""],
  ["RDWSD", "血液", "RDW-SD", "fL", 38.8, 50.0, "基準内", ""],
  ["RDWCV", "血液", "RDW-CV", "%", 11.5, 13.8, "基準内", ""],
  ["PLT", "血液", "血小板数", "10^3/μL", 158, 348, "基準内", ""],
  ["PDW", "血液", "PDW", "fL", 10.0, 15.3, "基準内", ""],
  ["MPV", "血液", "MPV", "fL", 8.3, 11.5, "基準内", ""],
  ["PLCR", "血液", "P-LCR", "%", 14.8, 37.1, "基準内", ""],
  ["Nn", "白血球分画", "好中球#", "10^3/μL", 1.27, 6.92, "基準内", ""],
  ["Ln", "白血球分画", "リンパ球#", "10^3/μL", 0.54, 4.26, "基準内", ""],
  ["Mn", "白血球分画", "単球#", "10^3/μL", 0.07, 0.86, "基準内", ""],
  ["En", "白血球分画", "好酸球#", "10^3/μL", 0.0, 0.73, "基準内", ""],
  ["Bn", "白血球分画", "好塩基球#", "10^3/μL", 0.0, 0.22, "基準内", ""],
  ["Np", "白血球分画", "好中球%", "%", 38.5, 80.5, "基準内", ""],
  ["Lp", "白血球分画", "リンパ球%", "%", 16.5, 49.5, "基準内", ""],
  ["Mp", "白血球分画", "単球%", "%", 2.0, 10.0, "基準内", ""],
  ["Ep", "白血球分画", "好酸球%", "%", 0.0, 8.5, "基準内", ""],
  ["Bp", "白血球分画", "好塩基球%", "%", 0.0, 2.5, "基準内", ""],
  ["uCol", "尿定性", "尿色調", "", "", "", "", ""],
  ["uTurb", "尿定性", "尿混濁", "", "", "", "", ""],
  ["SG", "尿定性", "尿比重", "", 1.01, 1.025, "基準内", "◎"],
  ["pH", "尿定性", "尿pH", "", 4.5, 7.5, "基準内", ""],
  ["uPro", "尿定性", "尿蛋白", "mg/dL", "", "", "低いほど良い", "◎"],
  ["uGlu", "尿定性", "尿糖", "mg/dL", "", "", "", ""],
  ["uKet", "尿定性", "ケトン体", "mg/dL", "", "", "", ""],
  ["uOB", "尿定性", "尿潜血", "mg/dL", "", "", "低いほど良い", "◎"],
  ["uUro", "尿定性", "ウロビリノーゲン", "", "", "", "", ""],
  ["uBil", "尿定性", "尿ビリルビン", "mg/dL", "", "", "", ""],
  ["uNit", "尿定性", "亜硝酸塩", "", "", "", "", ""],
  ["uLeu", "尿定性", "白血球反応", "個/μL", "", "", "", ""],
  ["sRBC", "尿沈渣", "RBCスウ", "/μL", "", 20.0, "低いほど良い", "◎"],
  ["RBCHPF", "尿沈渣", "RBC/F", "/HPF", "", 5.0, "低いほど良い", "◎"],
  ["sWBC", "尿沈渣", "WBCスウ", "/μL", "", 20.0, "低いほど良い", "◎"],
  ["WBCHPF", "尿沈渣", "WBC/F", "/HPF", "", 5.0, "低いほど良い", "◎"],
  ["CellN", "尿沈渣", "サイボウスウ", "/μL", "", "", "", ""],
  ["CellF", "尿沈渣", "サイボウ/F", "/HPF", "", "", "", ""],
  ["CastN", "尿沈渣", "ショウシエンチュ", "/μL", "", "", "", "◎"],
  ["CastF", "尿沈渣", "ショウシ/F", "/LPF", "", "", "", "◎"],
  ["BactN", "尿沈渣", "サイキンスウ", "/μL", "", 100, "", ""],
  ["BactF", "尿沈渣", "サイキン/F", "/HPF", "", 18.0, "", ""],
  ["RBCm", "尿沈渣", "RBCケイタイ", "", "", "", "", ""],
  ["RBCvis", "尿沈渣", "RBC(目視)", "/HPF", "", "", "", ""],
  ["WBCvis", "尿沈渣", "WBC(目視)", "/HPF", "", "", "", ""],
  ["FlatVis", "尿沈渣", "ヘンペイ(目視)", "/HPF", "", "", "", ""],
  ["UTP", "尿中定量", "U-TPテイリョ", "mg/dL", "", "", "低いほど良い", "◎"],
  ["UUN", "尿中定量", "U-UN", "mg/dL", "", "", "", ""],
  ["UCre", "尿中定量", "U-CRE", "mg/dL", "", "", "", ""],
  ["UUa", "尿中定量", "U-Ua", "", "", "", "", ""],
  ["UIP", "尿中定量", "U-IP", "mg/dL", "", "", "", ""],
  ["UNa", "尿中定量", "U-Na", "mmol/L", "", "", "", ""],
  ["UK", "尿中定量", "U-K", "mmol/L", "", "", "", ""],
  ["UCl", "尿中定量", "U-Cl", "mmol/L", "", "", "", ""],
  ["PCR", "尿中定量", "尿中蛋白/Cre比", "g/gCRE", "", 0.15, "低いほど良い", "◎"],
  ["VB12", "その他", "VB12", "pg/mL", 233, 914, "基準内", ""],
  ["Fol", "その他", "葉酸", "ng/mL", 3.6, 12.9, "基準内", ""],
  ["U24", "その他", "24h尿量", "mL", "", "", "", ""],
  ["Meta", "その他", "メタネフィリン", "mg/day", 0.04, 0.18, "基準内", ""],
  ["Norm", "その他", "ノルメタネフィリン", "mg/day", 0.1, 0.28, "基準内", ""]
];

// 1行=1回の検査。「検査日 到着時間 元ファイル ページ | キー=値 キー=値 ...」
// 値は数値、「数値(定性)」(例 15(+-))、または文字(例 (-)、<1.0、淡黄色)
var DATA = [
  "2026-10-22 09:03 R8.pdf 1 | TP=7.7 Alb=4.3 AG=1.26 CRP=0.04 TBil=1.9 AST=23 ALT=17 ALP=69 GGT=38 LD=169 CK=70 TC=209 HDL=49.8 LDL=138 TG=106 BUN=11.0 Cre=1.22 eGFR=50.78 UA=5.7 Ca=9.6 cCa=9.6 IP=3.1 Mg=2.2 Na=141 K=4.6 Cl=107 sHem=(-) sChy=(-) sYel=(-) Glu=91 WBC=3.96 RBC=5.91 Hb=17.9 Ht=54.1 MCV=91.5 MCH=30.3 MCHC=33.1 RDWSD=42.5 RDWCV=12.6 PLT=287 PDW=10.4 MPV=9.1 PLCR=18.2 Nn=2.20 Ln=1.33 Mn=0.32 En=0.07 Bn=0.04 Np=55.5 Lp=33.6 Mp=8.1 Ep=1.8 Bp=1.0 uCol=黄色 uTurb=(-) SG=1.023 pH=5.0 uPro=15(+-) uGlu=(-) uKet=(-) uOB=(-) uUro=NORMAL uBil=(-) uNit=(-) uLeu=(-) sRBC=5.8 RBCHPF=1.0 sWBC=4.5 WBCHPF=0.8 CellN=2.4 CellF=0.4 CastN=<1.00 CastF=<2.90 BactN=10.4 BactF=1.9 RBCm=判定なし UTP=16.5 UUN=536.6 UCre=208.72 UUa=88.8 UIP=69.8 UNa=145 UK=53.1 UCl=91 PCR=0.08",
  "2026-08-20 08:19 R8.pdf 2 | TP=6.7 Alb=3.7 AG=1.23 CRP=0.06 TBil=0.6 AST=20 ALT=17 ALP=73 GGT=39 LD=151 CK=68 TC=162 HDL=25.2 LDL=97 TG=199 BUN=14.9 Cre=1.20 eGFR=51.71 UA=5.5 Ca=9.1 cCa=9.4 IP=2.8 Mg=2.1 Na=142 K=4.3 Cl=106 sHem=(-) sChy=(+-) sYel=(-) Glu=112 WBC=4.50 RBC=5.25 Hb=16.2 Ht=48.7 MCV=92.8 MCH=30.9 MCHC=33.3 RDWSD=41.9 RDWCV=12.2 PLT=229 PDW=10.2 MPV=9.2 PLCR=18.9 Nn=2.75 Ln=1.30 Mn=0.29 En=0.13 Bn=0.03 Np=61.1 Lp=28.9 Mp=6.4 Ep=2.9 Bp=0.7 uCol=淡黄色 uTurb=(-) SG=1.025 pH=6.0 uPro=(-) uGlu=2000(4+) uKet=(-) uOB=(-) uUro=NORMAL uBil=(-) uNit=(-) uLeu=(-) sRBC=<1.0 RBCHPF=<0.2 sWBC=<1.0 WBCHPF=<0.2 CellN=<1.0 CellF=<0.2 CastN=<1.00 CastF=<2.90 BactN=<5.0 BactF=<0.9 RBCm=判定なし UTP=4.9 UUN=401.7 UCre=66.46 UUa=33.7 UIP=29.4 UNa=85 UK=17.7 UCl=71 PCR=0.07",
  "2026-06-18 08:14 R8.pdf 3 | TP=6.6 Alb=3.7 AG=1.28 CRP=0.05 TBil=1.0 AST=17 ALT=11 ALP=60 GGT=28 LD=147 CK=66 TC=166 HDL=35.0 LDL=104 TG=135 BUN=16.6 Cre=1.22 eGFR=50.78 UA=5.4 Ca=9.3 cCa=9.6 IP=2.9 Mg=2.2 Na=142 K=5.0 Cl=107 sHem=(-) sChy=(-) sYel=(-) Glu=113 WBC=4.04 RBC=5.31 Hb=16.2 Ht=49.1 MCV=92.5 MCH=30.5 MCHC=33.0 RDWSD=42.0 RDWCV=12.3 PLT=267 PDW=10.0 MPV=9.5 PLCR=20.7 Nn=2.20 Ln=1.34 Mn=0.33 En=0.13 Bn=0.04 Np=54.4 Lp=33.2 Mp=8.2 Ep=3.2 Bp=1.0 uCol=淡黄色 uTurb=(-) SG=1.021 pH=6.5 uPro=(-) uGlu=2000(4+) uKet=(-) uOB=(-) uUro=NORMAL uBil=(-) uNit=(-) uLeu=(-) sRBC=<1.0 RBCHPF=<0.2 sWBC=<1.0 WBCHPF=<0.2 CellN=<1.0 CellF=<0.2 CastN=<1.00 CastF=<2.90 BactN=<5.0 BactF=<0.9 RBCm=判定なし UTP=3.5 UUN=407.6 UCre=58.78 UUa=31.6 UIP=24.9 UNa=68 UK=22.2 UCl=64 PCR=0.06",
  "2026-04-23 08:10 R8.pdf 4 | TP=7.0 Alb=3.9 AG=1.26 CRP=0.04 TBil=0.8 AST=21 ALT=14 ALP=70 GGT=32 LD=164 CK=76 TC=160 HDL=32.8 LDL=97 TG=151 BUN=15.7 Cre=1.17 eGFR=53.47 UA=5.4 Ca=9.3 cCa=9.4 IP=3.3 Mg=2.2 Na=141 K=4.7 Cl=106 sHem=(-) sChy=(-) sYel=(-) Glu=106 WBC=5.63 RBC=5.50 Hb=16.8 Ht=51.1 MCV=92.9 MCH=30.5 MCHC=32.9 RDWSD=42.4 RDWCV=12.3 PLT=255 PDW=10.2 MPV=9.2 PLCR=19.5 Nn=3.90 Ln=1.18 Mn=0.40 En=0.12 Bn=0.03 Np=69.3 Lp=21.0 Mp=7.1 Ep=2.1 Bp=0.5 uCol=淡黄色 uTurb=(-) SG=1.013 pH=5.5 uPro=(-) uGlu=2000(4+) uKet=(-) uOB=(-) uUro=NORMAL uBil=(-) uNit=(-) uLeu=(-) sRBC=1.3 RBCHPF=0.2 sWBC=<1.0 WBCHPF=<0.2 CellN=<1.0 CellF=<0.2 CastN=<1.00 CastF=<2.90 BactN=<5.0 BactF=<0.9 RBCm=判定なし UTP=3.5 UUN=273.0 UCre=40.55 UUa=26.1 UIP=23.8 UNa=50 UK=14.3 UCl=43 PCR=0.09",
  "2026-02-26 08:11 R8.pdf 5 | TP=6.7 Alb=3.8 AG=1.31 CRP=0.12 TBil=0.9 AST=16 ALT=10 ALP=61 GGT=21 LD=157 CK=59 TC=163 HDL=41.2 LDL=105 TG=84 BUN=13.8 Cre=1.19 eGFR=52.49 UA=4.8 Ca=9.4 cCa=9.6 IP=3.4 Mg=2.1 Na=141 K=4.9 Cl=106 sHem=(-) sChy=(-) sYel=(-) Glu=112 A1c=5.3 WBC=3.75 RBC=5.18 Hb=15.9 Ht=48.6 MCV=93.8 MCH=30.7 MCHC=32.7 RDWSD=43.3 RDWCV=12.5 PLT=268 PDW=10.7 MPV=9.4 PLCR=20.1 Nn=2.26 Ln=1.09 Mn=0.26 En=0.11 Bn=0.03 Np=60.3 Lp=29.1 Mp=6.9 Ep=2.9 Bp=0.8 uCol=淡黄色 uTurb=(-) SG=1.027 pH=6.5 uPro=(-) uGlu=2000(4+) uKet=(-) uOB=(-) uUro=NORMAL uBil=(-) uNit=(-) uLeu=(-) sRBC=<1.0 RBCHPF=<0.2 sWBC=1.0 WBCHPF=0.2 CellN=<1.0 CellF=<0.2 CastN=<1.00 CastF=<2.90 BactN=<5.0 BactF=<0.9 RBCm=判定なし UTP=7.0 UUN=437.0 UCre=76.32 UUa=43.2 UIP=35.0 UNa=96 UK=22.5 UCl=86 PCR=0.09",
  "2026-01-15 08:13 R8.pdf 6 | TP=7.0 Alb=3.9 AG=1.26 CRP=0.05 TBil=0.8 AST=21 ALT=14 ALP=60 GGT=27 LD=159 CK=125 TC=158 HDL=34.2 LDL=99 TG=124 BUN=16.6 Cre=1.18 eGFR=52.98 UA=5.6 Ca=9.3 cCa=9.4 IP=3.3 Mg=2.2 Na=141 K=4.9 Cl=106 sHem=(-) sChy=(-) sYel=(-) Glu=104 A1c=5.3 WBC=4.66 RBC=5.45 Hb=16.6 Ht=50.1 MCV=91.9 MCH=30.5 MCHC=33.1 RDWSD=42.9 RDWCV=12.8 PLT=297 PDW=9.8 MPV=9.1 PLCR=17.9 Nn=2.77 Ln=1.38 Mn=0.37 En=0.11 Bn=0.03 Np=59.5 Lp=29.6 Mp=7.9 Ep=2.4 Bp=0.6 uCol=黄色 uTurb=(-) SG=1.034 pH=5.5 uPro=(-) uGlu=2000(4+) uKet=(-) uOB=(-) uUro=NORMAL uBil=(-) uNit=(-) uLeu=(-) sRBC=<1.0 RBCHPF=<0.2 sWBC=2.0 WBCHPF=0.4 CellN=1.3 CellF=0.2 CastN=<1.00 CastF=<2.90 BactN=6.9 BactF=1.2 RBCm=判定なし UTP=10.6 UUN=600.4 UCre=98.07 UUa=64.3 UIP=59.3 UNa=71 UK=35.1 UCl=76 PCR=0.11",
  "2025-12-02 08:15 R7.pdf 1 | TP=6.8 Alb=3.9 AG=1.34 CRP=0.03 TBil=1.0 AST=18 ALT=13 ALP=58 GGT=25 LD=147 CK=65 TC=170 HDL=33.2 LDL=112 TG=124 BUN=16.8 Cre=1.17 eGFR=53.47 UA=5.2 Ca=9.2 cCa=9.3 IP=3.2 Mg=2.3 Na=142 K=4.5 Cl=106 sHem=(-) sChy=(-) sYel=(-) Glu=135 A1c=5.4 WBC=3.58 RBC=5.34 Hb=16.2 Ht=48.5 MCV=90.8 MCH=30.3 MCHC=33.4 RDWSD=41.3 RDWCV=12.7 PLT=267 PDW=9.9 MPV=9.3 PLCR=18.9 Nn=2.06 Ln=1.14 Mn=0.26 En=0.10 Bn=0.02 Np=57.5 Lp=31.8 Mp=7.3 Ep=2.8 Bp=0.6 uCol=淡黄色 uTurb=(-) SG=1.022 pH=6.0 uPro=(-) uGlu=2000(4+) uKet=(-) uOB=(-) uUro=NORMAL uBil=(-) uNit=(-) uLeu=(-) sRBC=<1.0 RBCHPF=<0.2 sWBC=<1.0 WBCHPF=<0.2 CellN=<1.0 CellF=<0.2 CastN=<1.00 CastF=<2.90 BactN=<5.0 BactF=<0.9 RBCm=判定なし UTP=5.7 UUN=442.7 UCre=64.54 UUa=35.7 UIP=37.8 UNa=78 UK=21.6 UCl=72 PCR=0.09",
  "2025-10-23 08:38 R7.pdf 2 | TP=8.1 Alb=4.6 AG=1.31 CRP=0.05 TBil=1.6 AST=22 ALT=14 ALP=70 GGT=29 LD=180 CK=77 TC=224 HDL=47.0 LDL=158 TG=95 BUN=14.0 Cre=1.30 eGFR=47.65 UA=6.0 Ca=9.8 cCa=9.8 IP=3.6 Mg=2.3 Na=141 K=4.5 Cl=105 sHem=(-) sChy=(-) sYel=(-) Glu=86 A1c=5.5 WBC=4.22 RBC=6.10 Hb=18.4 Ht=55.1 MCV=90.3 MCH=30.2 MCHC=33.4 RDWSD=41.2 RDWCV=12.6 PLT=314 PDW=10.0 MPV=9.2 PLCR=18.6 Nn=2.34 Ln=1.44 Mn=0.28 En=0.11 Bn=0.05 Np=55.5 Lp=34.1 Mp=6.6 Ep=2.6 Bp=1.2 uCol=黄色 uTurb=(-) SG=1.032 pH=5.0 uPro=15(+-) uGlu=2000(4+) uKet=10(1+) uOB=(-) uUro=NORMAL uBil=(-) uNit=(-) uLeu=(-) sRBC=1.1 RBCHPF=0.2 sWBC=9.8 WBCHPF=1.8 CellN=4.2 CellF=0.8 CastN=1.96 CastF=5.68 BactN=16.2 BactF=2.9 RBCm=判定なし UTP=31.0 UUN=555.1 UCre=178.53 UUa=76.5 UIP=77.0 UNa=114 UK=42.6 UCl=59 PCR=0.17",
  "2025-09-18 08:17 R7.pdf 3 | TP=6.7 Alb=3.8 AG=1.31 CRP=0.05 TBil=0.8 AST=17 ALT=15 ALP=74 GGT=30 LD=153 CK=56 TC=174 HDL=13.0 LDL=105 TG=280 BUN=17.0 Cre=1.24 eGFR=50.18 UA=5.6 Ca=9.1 cCa=9.3 IP=3.2 Mg=2.1 Na=140 K=4.1 Cl=105 sHem=(-) sChy=(+-) sYel=(-) Glu=124 A1c=5.4 WBC=5.26 RBC=5.47 Hb=16.0 Ht=48.1 MCV=87.9 MCH=29.3 MCHC=33.3 RDWSD=41.1 RDWCV=12.6 PLT=261 PDW=10.0 MPV=9.2 PLCR=18.6 Nn=3.22 Ln=1.46 Mn=0.36 En=0.18 Bn=0.04 Np=61.2 Lp=27.8 Mp=6.8 Ep=3.4 Bp=0.8 uCol=淡黄色 uTurb=(-) SG=1.018 pH=5.5 uPro=(-) uGlu=2000(4+) uKet=(-) uOB=(-) uUro=NORMAL uBil=(-) uNit=(-) uLeu=(-) sRBC=<1.0 RBCHPF=<0.2 sWBC=<1.0 WBCHPF=<0.2 CellN=<1.0 CellF=<0.2 CastN=<1.00 CastF=<2.90 BactN=6.9 BactF=1.2 RBCm=判定なし UTP=8.3 UUN=440.5 UCre=64.74 UUa=31.5 UIP=32.6 UNa=44 UK=27.0 UCl=44 PCR=0.13",
  "2025-08-05 08:10 R7.pdf 4 | TP=6.7 Alb=3.8 AG=1.31 CRP=0.04 TBil=0.9 AST=15 ALT=10 ALP=67 GGT=19 LD=158 CK=82 TC=160 HDL=33.2 LDL=101 TG=129 BUN=14.1 Cre=1.26 eGFR=49.31 UA=5.1 Ca=9.1 cCa=9.3 IP=3.1 Mg=2.1 Na=142 K=4.3 Cl=107 sHem=(-) sChy=(-) sYel=(-) Glu=115 A1c=5.4 WBC=4.47 RBC=5.09 Hb=15.2 Ht=45.6 MCV=89.6 MCH=29.9 MCHC=33.3 RDWSD=42.3 RDWCV=12.9 PLT=284 PDW=10.1 MPV=9.3 PLCR=19.9 Nn=2.65 Ln=1.37 Mn=0.29 En=0.14 Bn=0.02 Np=59.4 Lp=30.6 Mp=6.5 Ep=3.1 Bp=0.4 uCol=淡黄色 uTurb=(-) SG=1.024 pH=6.5 uPro=(-) uGlu=2000(4+) uKet=(-) uOB=(-) uUro=NORMAL uBil=(-) uNit=(-) uLeu=(-) sRBC=<1.0 RBCHPF=<0.2 sWBC=1.3 WBCHPF=0.2 CellN=<1.0 CellF=<0.2 CastN=<1.00 CastF=<2.90 BactN=<5.0 BactF=<0.9 RBCm=判定なし UTP=10.2 UUN=384.7 UCre=65.51 UUa=35.5 UIP=29.3 UNa=85 UK=19.6 UCl=77 PCR=0.16",
  "2025-07-08 08:20 R7.pdf 5 | TP=6.3 Alb=3.4 AG=1.17 CRP=0.10 TBil=0.6 AST=14 ALT=10 ALP=67 GGT=21 LD=160 CK=85 TC=150 HDL=31.2 LDL=96 TG=114 BUN=13.2 Cre=1.22 eGFR=51.08 UA=5.5 Ca=8.8 cCa=9.1 IP=2.7 Mg=2.2 Na=142 K=4.0 Cl=108 sHem=(-) sChy=(-) sYel=(-) Glu=135 A1c=5.4 WBC=4.16 RBC=4.92 Hb=14.4 Ht=43.4 MCV=88.2 MCH=29.3 MCHC=33.2 RDWSD=41.3 RDWCV=12.8 PLT=252 PDW=9.8 MPV=9.2 PLCR=18.4 Nn=2.45 Ln=1.25 Mn=0.28 En=0.14 Bn=0.04 Np=58.9 Lp=30.0 Mp=6.7 Ep=3.4 Bp=1.0 uCol=淡黄色 uTurb=(-) SG=1.025 pH=6.0 uPro=(-) uGlu=2000(4+) uKet=(-) uOB=(-) uUro=NORMAL uBil=(-) uNit=(-) uLeu=(-) sRBC=<1.0 RBCHPF=<0.2 sWBC=<1.0 WBCHPF=<0.2 CellN=<1.0 CellF=<0.2 CastN=<1.00 CastF=<2.90 BactN=<5.0 BactF=<0.9 RBCm=判定なし UTP=8.2 UUN=353.4 UCre=71.65 UUa=33.8 UIP=20.4 UNa=79 UK=16.8 UCl=76 PCR=0.11",
  "2025-06-10 08:17 R7.pdf 6 | TP=6.5 Alb=3.7 AG=1.32 CRP=0.06 TBil=0.6 AST=17 ALT=13 ALP=75 GGT=29 LD=144 CK=63 TC=168 HDL=27.0 LDL=110 TG=155 BUN=15.9 Cre=1.27 eGFR=48.88 UA=5.0 Ca=8.9 cCa=9.2 IP=2.5 Mg=2.2 Na=139 K=3.8 Cl=107 sHem=(-) sChy=(-) sYel=(-) Glu=151 A1c=5.5 WBC=5.72 RBC=5.39 Hb=15.1 Ht=44.5 MCV=82.6 MCH=28.0 MCHC=33.9 RDWSD=38.3 RDWCV=12.7 PLT=300 PDW=9.2 MPV=8.6 PLCR=14.4 Nn=3.45 Ln=1.64 Mn=0.36 En=0.23 Bn=0.04 Np=60.3 Lp=28.7 Mp=6.3 Ep=4.0 Bp=0.7 uCol=淡黄色 uTurb=(-) SG=1.027 pH=7.0 uPro=15(+-) uGlu=2000(4+) uKet=(-) uOB=(-) uUro=NORMAL uBil=(-) uNit=(-) uLeu=(-) sRBC=<1.0 RBCHPF=<0.2 sWBC=1.0 WBCHPF=0.2 CellN=1.0 CellF=0.2 CastN=<1.00 CastF=<2.90 BactN=12.7 BactF=2.3 RBCm=判定なし UTP=18.4 UUN=359.1 UCre=73.08 UUa=29.1 UIP=13.1 UNa=55 UK=22.1 UCl=54 PCR=0.25",
  "2025-05-13 08:14 R7.pdf 7 | TP=6.5 Alb=3.7 AG=1.32 CRP=0.04 TBil=0.7 AST=16 ALT=12 ALP=69 GGT=25 LD=162 CK=67 TC=182 HDL=32.0 LDL=122 TG=140 BUN=14.4 Cre=1.18 eGFR=52.98 UA=5.1 Ca=8.9 cCa=9.2 IP=3.2 Mg=2.2 Na=143 K=4.4 Cl=105 sHem=(-) sChy=(-) sYel=(-) Glu=127 A1c=5.3 WBC=4.59 RBC=5.21 Hb=14.8 Ht=44.9 MCV=86.2 MCH=28.4 MCHC=33.0 RDWSD=42.0 RDWCV=13.5 PLT=300 PDW=9.3 MPV=9.0 PLCR=16.6 Nn=2.77 Ln=1.30 Mn=0.34 En=0.14 Bn=0.04 Np=60.3 Lp=28.3 Mp=7.4 Ep=3.1 Bp=0.9 uCol=淡黄色 uTurb=(-) SG=1.023 pH=6.5 uPro=15(+-) uGlu=2000(4+) uKet=(-) uOB=(-) uUro=NORMAL uBil=(-) uNit=(-) uLeu=(-) sRBC=1.4 RBCHPF=0.3 sWBC=<1.0 WBCHPF=<0.2 CellN=<1.0 CellF=<0.2 CastN=<1.00 CastF=<2.90 BactN=<5.0 BactF=<0.9 RBCm=判定なし UTP=25.2 UUN=395.4 UCre=76.77 UUa=36.8 UIP=28.6 UNa=91 UK=33.8 UCl=92 PCR=0.33",
  "2025-04-08 08:13 R7.pdf 8 | TP=6.9 Alb=3.7 AG=1.16 CRP=0.07 TBil=0.7 AST=13 ALT=8 ALP=83 GGT=20 LD=141 CK=56 TC=188 HDL=30.4 LDL=129 TG=143 BUN=14.3 Cre=1.32 eGFR=47.14 UA=5.5 Ca=9.2 cCa=9.5 IP=3.4 Mg=2.1 Na=141 K=4.0 Cl=104 sHem=(-) sChy=(+-) sYel=(-) Glu=114 WBC=4.42 RBC=5.44 Hb=15.3 Ht=46.0 MCV=84.6 MCH=28.1 MCHC=33.3 RDWSD=41.1 RDWCV=13.4 PLT=301 PDW=9.7 MPV=8.8 PLCR=15.8 Nn=2.65 Ln=1.27 Mn=0.27 En=0.19 Bn=0.04 Np=60.0 Lp=28.7 Mp=6.1 Ep=4.3 Bp=0.9 uCol=淡黄色 uTurb=(-) SG=1.027 pH=6.5 uPro=15(+-) uGlu=2000(4+) uKet=(-) uOB=(-) uUro=NORMAL uBil=(-) uNit=(-) uLeu=(-) sRBC=<1.0 RBCHPF=<0.2 sWBC=1.5 WBCHPF=0.3 CellN=1.3 CellF=0.2 CastN=<1.00 CastF=<2.90 BactN=<5.0 BactF=<0.9 RBCm=判定なし UTP=20.4 UUN=384.1 UCre=82.37 UUa=31.7 UIP=38.4 UNa=52 UK=25.3 UCl=42 PCR=0.25",
  "2025-03-04 08:37 R7.pdf 9 | TP=6.8 Alb=3.5 AG=1.06 CRP=0.37 TBil=0.5 AST=14 ALT=11 ALP=97 GGT=24 LD=146 CK=47 TC=173 HDL=10.8 LDL=115 TG=236 BUN=18.3 Cre=1.35 eGFR=45.99 UA=5.7 Ca=9.0 cCa=9.2 IP=3.3 Mg=2.1 Na=139 K=4.6 Cl=103 sHem=(-) sChy=(+-) sYel=(-) Glu=109 WBC=5.82 RBC=5.38 Hb=14.6 Ht=45.4 MCV=84.4 MCH=27.1 MCHC=32.2 RDWSD=38.3 RDWCV=12.6 PLT=337 PDW=9.7 MPV=8.6 PLCR=15.1 Nn=3.75 Ln=1.31 Mn=0.51 En=0.22 Bn=0.03 Np=64.4 Lp=22.5 Mp=8.8 Ep=3.8 Bp=0.5 uCol=淡黄色 uTurb=(-) SG=1.027 pH=7.0 uPro=15(+-) uGlu=2000(4+) uKet=(-) uOB=(-) uUro=NORMAL uBil=(-) uNit=(-) uLeu=(-) sRBC=1.9 RBCHPF=0.3 sWBC=<1.0 WBCHPF=<0.2 CellN=<1.0 CellF=<0.2 CastN=<1.00 CastF=<2.90 BactN=<5.0 BactF=<0.9 RBCm=判定なし UTP=29.9 UUN=497.5 UCre=88.91 UUa=46.0 UIP=33.6 UNa=50 UK=40.5 UCl=46 PCR=0.34",
  "2025-02-04 08:23 R7.pdf 10 | TP=7.3 Alb=3.8 AG=1.09 CRP=6.51 TBil=1.0 AST=18 ALT=9 ALP=93 GGT=20 LD=158 CK=66 TC=188 HDL=39.4 LDL=127 TG=108 BUN=14.4 Cre=1.79 eGFR=33.78 UA=5.0 Ca=9.1 cCa=9.3 IP=2.9 Mg=2.3 Na=137 K=4.2 Cl=100 sHem=(-) sChy=(-) sYel=(-) Glu=111 WBC=6.09 RBC=5.28 Hb=14.9 Ht=45.3 MCV=85.8 MCH=28.2 MCHC=32.9 RDWSD=39.3 RDWCV=12.5 PLT=256 PDW=9.7 MPV=9.2 PLCR=18.0 Nn=4.60 Ln=0.93 Mn=0.50 En=0.03 Bn=0.03 Np=75.5 Lp=15.3 Mp=8.2 Ep=0.5 Bp=0.5 uCol=淡黄色 uTurb=(-) SG=1.012 pH=6.5 uPro=15(+-) uGlu=2000(4+) uKet=(-) uOB=(-) uUro=NORMAL uBil=(-) uNit=(-) uLeu=(-) sRBC=3.6 RBCHPF=0.6 sWBC=1.3 WBCHPF=0.2 CellN=1.0 CellF=0.2 CastN=<1.00 CastF=<2.90 BactN=8.1 BactF=1.5 RBCm=判定なし RBCvis=<1/HPF WBCvis=<1/HPF FlatVis=<1/HPF UTP=14.1 UUN=139.4 UCre=42.16 UUa=8.4 UIP=3.7 UNa=<10 UK=8.9 UCl=10 PCR=0.33",
  "2025-01-07 08:14 R7.pdf 11 | TP=7.1 Alb=4.0 AG=1.29 CRP=0.17 TBil=0.9 AST=14 ALT=9 ALP=82 GGT=22 LD=149 CK=76 BUN=13.8 Cre=1.67 eGFR=36.44 UA=6.4 Ca=9.5 cCa=9.5 IP=3.2 Mg=2.3 Na=140 K=4.2 Cl=102 sHem=(-) sChy=(-) sYel=(-) Glu=115 WBC=5.19 RBC=5.21 Hb=14.5 Ht=44.6 MCV=85.6 MCH=27.8 MCHC=32.5 RDWSD=39.0 RDWCV=12.7 PLT=316 PDW=9.6 MPV=9.0 PLCR=16.3 Nn=3.49 Ln=1.20 Mn=0.32 En=0.14 Bn=0.04 Np=67.2 Lp=23.1 Mp=6.2 Ep=2.7 Bp=0.8 uCol=淡黄色 uTurb=(-) SG=1.017 pH=5.5 uPro=15(+-) uGlu=2000(4+) uKet=(-) uOB=(-) uUro=NORMAL uBil=(-) uNit=(-) uLeu=(-) sRBC=1.5 RBCHPF=0.3 sWBC=1.0 WBCHPF=0.2 CellN=<1.0 CellF=0.2 CastN=<1.00 CastF=<2.90 BactN=<5.0 BactF=<0.9 RBCm=判定なし UTP=22.6 UUN=255.1 UCre=61.34 UUa=27.7 UIP=21.1 UNa=40 UK=18.3 UCl=39 PCR=0.37",
  "2024-12-17 08:17 R6.pdf 1 | Alb=4.0 BUN=17.5 Cre=1.62 eGFR=37.68 UA=5.7 Ca=9.1 cCa=9.1 IP=3.1 Na=142 K=4.1 Cl=105 sHem=(-) sChy=(+) sYel=(-) uCol=淡黄色 uTurb=(-) SG=1.020 pH=6.0 uPro=15(+-) uGlu=2000(4+) uKet=(-) uOB=(-) uUro=NORMAL uBil=(-) uNit=(-) uLeu=(-) sRBC=2.9 RBCHPF=0.5 sWBC=1.8 WBCHPF=0.3 CellN=<1.0 CellF=<0.2 CastN=<1.00 CastF=<2.90 BactN=<5.0 BactF=<0.9 RBCm=判定なし UTP=25.7 UUN=339.5 UCre=66.21 UUa=24.7 UIP=26.7 UNa=50 UK=19.2 UCl=41 PCR=0.39",
  "2024-12-03 08:17 R6.pdf 2 | TP=6.3 Alb=3.4 AG=1.17 CRP=0.04 TBil=0.4 AST=16 ALT=13 ALP=68 GGT=22 LD=135 CK=57 BUN=15.4 Cre=1.65 eGFR=36.93 UA=6.0 Ca=8.9 cCa=9.2 IP=3.3 Mg=2.0 Na=141 K=4.3 Cl=106 sHem=(-) sChy=(+-) sYel=(-) Glu=122 WBC=4.54 RBC=4.29 Hb=12.0 Ht=37.3 MCV=86.9 MCH=28.0 MCHC=32.2 RDWSD=39.5 RDWCV=12.4 PLT=266 PDW=9.0 MPV=8.6 PLCR=14.2 Nn=2.79 Ln=1.20 Mn=0.36 En=0.17 Bn=0.02 Np=61.6 Lp=26.4 Mp=7.9 Ep=3.7 Bp=0.4 uCol=淡黄色 uTurb=(-) SG=1.007 pH=6.0 uPro=15(+-) uGlu=(-) uKet=(-) uOB=(-) uUro=NORMAL uBil=(-) uNit=(-) uLeu=(-) sRBC=1.4 RBCHPF=0.3 sWBC=<1.0 WBCHPF=<0.2 CellN=<1.0 CellF=<0.2 CastN=<1.00 CastF=<2.90 BactN=<5.0 BactF=<0.9 RBCm=判定なし UTP=13.5 UUN=278.4 UCre=56.36 UUa=25.7 UIP=23.7 UNa=74 UK=28.9 UCl=77 PCR=0.24",
  "2024-11-27 08:11 R6.pdf 3 | Alb=3.5 BUN=17.8 Cre=1.81 eGFR=33.37 UA=6.7 Ca=8.8 cCa=9.0 IP=3.1 Na=142 K=4.0 Cl=107 sHem=(-) sChy=(-) sYel=(-) uCol=黄色 uTurb=(-) SG=1.015 pH=6.0 uPro=30(1+) uGlu=50(+-) uKet=(-) uOB=(-) uUro=NORMAL uBil=(-) uNit=(-) uLeu=(-) sRBC=2.2 RBCHPF=0.4 sWBC=4.3 WBCHPF=0.8 CellN=3.1 CellF=0.6 CastN=1.26 CastF=3.65 BactN=9.2 BactF=1.7 RBCm=判定なし UTP=36.9 UUN=641.4 UCre=142.32 UUa=52.7 UIP=67.4 UNa=62 UK=30.8 UCl=56 PCR=0.26",
  "2024-11-22 08:12 R6.pdf 4 | Alb=3.6 BUN=34.3 Cre=2.57 eGFR=22.74 UA=9.1 Ca=9.0 cCa=9.4 IP=4.1 Na=139 K=5.7 Cl=106 sHem=(-) sChy=(+) sYel=(-) uCol=淡黄色 uTurb=(-) SG=1.008 pH=5.5 uPro=(-) uGlu=(-) uKet=(-) uOB=(-) uUro=NORMAL uBil=(-) uNit=(-) uLeu=(-) sRBC=<1.0 RBCHPF=<0.2 sWBC=<1.0 WBCHPF=<0.2 CellN=<1.0 CellF=<0.2 CastN=<1.00 CastF=<2.90 BactN=<5.0 BactF=<0.9 RBCm=判定なし UTP=16.3 UUN=391.8 UCre=61.05 UUa=32.5 UIP=31.3 UNa=47 UK=39.3 UCl=55 PCR=0.27",
  "2024-10-15 07:58 R6.pdf 5-6 | Cu=127 TP=5.5 Alb=2.5 AG=0.83 CRP=1.00 TBil=0.3 DBil=0.1 AST=24 ALT=37 ALP=135 GGT=75 LD=197 CK=20 Amy=114 BUN=9.8 Cre=1.74 eGFR=34.84 UA=5.3 Ca=8.3 cCa=9.5 IP=2.6 Mg=2.0 TSAT=17.9 Fe=49 UIBC=224 Ferr=239.5 Na=137 K=3.3 Cl=96 Zn=69.4 sHem=(-) sChy=(-) sYel=(-) Glu=147 WBC=8.35 RBC=4.01 Hb=11.5 Ht=34.9 MCV=87.0 MCH=28.7 MCHC=33.0 RDWSD=39.8 RDWCV=12.5 PLT=501 PDW=8.6 MPV=8.6 PLCR=13.3 Nn=6.02 Ln=1.14 Mn=0.76 En=0.39 Bn=0.04 Np=72.0 Lp=13.7 Mp=9.1 Ep=4.7 Bp=0.5 uCol=黄色 uTurb=(-) SG=1.010 pH=7.5 uPro=30(1+) uGlu=(-) uKet=(-) uOB=(-) uUro=NORMAL uBil=(-) uNit=(-) uLeu=(-) sRBC=3.6 RBCHPF=0.6 sWBC=3.7 WBCHPF=0.7 CellN=6.6 CellF=1.2 CastN=1.12 CastF=3.25 BactN=10.4 BactF=1.9 RBCm=判定なし UTP=63.8 UUN=255.2 UCre=113.30 UUa=45.5 UIP=19.0 UNa=82 UK=16.4 UCl=67 PCR=0.56 VB12=169 Fol=3.3",
  "2024-10-17 08:13 R6.pdf 6 | U24=2900 Meta=0.17 Norm=0.38",
  "2024-10-18 07:51 R6.pdf 5-6 | TP=6.2 Alb=2.9 AG=0.88 CRP=0.42 TBil=0.4 AST=30 ALT=36 ALP=134 GGT=64 LD=219 CK=30 BUN=11.9 Cre=1.60 eGFR=38.19 UA=5.6 Ca=8.8 cCa=9.6 IP=3.0 Mg=2.4 Na=137 K=4.0 Cl=98 sHem=(-) sChy=(-) sYel=(-) Glu=91 WBC=9.10 RBC=4.16 Hb=12.0 Ht=35.6 MCV=85.6 MCH=28.8 MCHC=33.7 RDWSD=38.8 RDWCV=12.5 PLT=486 PDW=8.2 MPV=8.4 PLCR=11.6 Nn=6.45 Ln=1.53 Mn=0.68 En=0.40 Bn=0.04 Np=70.9 Lp=16.8 Mp=7.5 Ep=4.4 Bp=0.4 uCol=淡黄色 uTurb=(-) SG=1.008 pH=7.5 uPro=30(1+) uGlu=(-) uKet=(-) uOB=(-) uUro=NORMAL uBil=(-) uNit=(-) uLeu=(-) sRBC=2.3 RBCHPF=0.4 sWBC=3.0 WBCHPF=0.5 CellN=4.6 CellF=0.8 CastN=<1.00 CastF=<2.90 BactN=<5.0 BactF=<0.9 RBCm=判定なし UTP=39.0 UUN=235.7 UCre=68.47 UUa=35.7 UNa=57 UK=14.4 UCl=39 PCR=0.57",
  "2024-11-05 09:20 R6.pdf 8 | uCol=淡黄色 uTurb=(-) SG=1.006 pH=7.5 uPro=15(+-) uGlu=(-) uKet=(-) uOB=(-) uUro=NORMAL uBil=(-) uNit=(-) uLeu=(-) sRBC=<1.0 RBCHPF=<0.2 sWBC=<1.0 WBCHPF=<0.2 CellN=<1.0 CellF=<0.2 CastN=<1.00 CastF=<2.90 BactN=<5.0 BactF=<0.9 RBCm=判定なし UTP=27.5 UUN=200.5 UCre=31.95 UUa=21.8 UIP=11.7 UNa=53 UK=30.3 UCl=54 PCR=0.86",
  "2024-11-05 09:41 R6.pdf 7 | TP=6.7 Alb=3.6 AG=1.16 CRP=0.07 TBil=0.5 AST=17 ALT=17 ALP=91 GGT=30 LD=161 CK=42 BUN=17.7 Cre=1.63 eGFR=37.42 UA=6.1 Ca=9.0 cCa=9.4 IP=3.4 Mg=2.2 Na=138 K=4.4 Cl=99 sHem=(-) sChy=(+-) sYel=(-) Glu=116 WBC=5.92 RBC=4.40 Hb=12.5 Ht=38.6 MCV=87.7 MCH=28.4 MCHC=32.4 RDWSD=39.9 RDWCV=12.4 PLT=336 PDW=8.7 MPV=8.5 PLCR=13.3 Nn=3.56 Ln=1.66 Mn=0.38 En=0.29 Bn=0.03 Np=60.2 Lp=28.0 Mp=6.4 Ep=4.9 Bp=0.5 VB12=照会不可 Fol=照会不可"
];

var REMARKS = {
  '2025-01-07 08:14|uTurb': '原本は( )表記'
};

function doGet(e) {
  return json_({ ok: true, version: CODE_VERSION });
}

function doPost(e) {
  try {
    var req = JSON.parse(e.postData.contents);
    if (req.action === 'ping') return json_({ ok: true, version: CODE_VERSION });
    if (req.action === 'append') return json_(append_(req.rows || []));
    if (req.action === 'list') return json_({ ok: true, rows: list_() });
    return json_({ ok: false, error: 'unknown action: ' + req.action });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ---- 初期整備 ----------------------------------------------------------

function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var rec = ss.getSheetByName(SHEET_RECORD) || ss.insertSheet(SHEET_RECORD);
  if (rec.getLastRow() > 1) {
    throw new Error('「' + SHEET_RECORD + '」シートにすでにデータがあります。上書きを防ぐため中止しました。');
  }
  var mst = ss.getSheetByName(SHEET_MASTER) || ss.insertSheet(SHEET_MASTER);
  writeMaster_(mst);
  var n = writeRecords_(rec);
  ss.setActiveSheet(rec);
  SpreadsheetApp.flush();
  return '記録 ' + n + '行、項目マスタ ' + MASTER.length + '項目を書き込みました';
}

function writeMaster_(sh) {
  sh.clear();
  var rows = MASTER.map(function (m, i) {
    return [i + 1, m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[0]];
  });
  sh.getRange(1, 1, 1, MASTER_HEADERS.length).setValues([MASTER_HEADERS]).setFontWeight('bold').setBackground('#e8eef7');
  sh.getRange(2, 1, rows.length, MASTER_HEADERS.length).setValues(rows);
  sh.setFrozenRows(1);
  sh.setColumnWidths(1, MASTER_HEADERS.length, 100);
  sh.setColumnWidth(3, 170);
}

function writeRecords_(sh) {
  var master = {};
  MASTER.forEach(function (m, i) { master[m[0]] = { idx: i, m: m }; });
  var rows = [];
  DATA.forEach(function (line) {
    var parts = line.split(' | ');
    var h = parts[0].split(' ');
    var date = h[0], time = h[1], file = h[2], page = h[3];
    parts[1].split(' ').forEach(function (tok) {
      var p = tok.indexOf('=');
      var key = tok.substring(0, p), raw = tok.substring(p + 1);
      var info = master[key];
      if (!info) throw new Error('項目マスタにないキー: ' + key);
      var m = info.m;
      var v = parseValue_(raw);
      rows.push({
        idx: info.idx, date: date, time: time,
        row: [date, time, m[1], m[2], v.num, v.qual, m[3], m[4], m[5],
              flag_(v.num, m[4], m[5]), REMARKS[date + ' ' + time + '|' + key] || '', file, page, '']
      });
    });
  });
  rows.sort(function (a, b) {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.time !== b.time) return a.time < b.time ? -1 : 1;
    return a.idx - b.idx;
  });
  var now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
  var out = rows.map(function (r) { r.row[13] = now; return r.row; });
  sh.clear();
  sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold').setBackground('#e8eef7');
  sh.getRange(2, 1, out.length, 2).setNumberFormat('@');
  sh.getRange(2, 1, out.length, HEADERS.length).setValues(out);
  sh.setFrozenRows(1);
  sh.getRange(1, 1, out.length + 1, HEADERS.length).createFilter();
  sh.setColumnWidths(1, HEADERS.length, 90);
  sh.setColumnWidth(4, 170);
  sh.setColumnWidth(14, 140);
  return out.length;
}

function parseValue_(raw) {
  if (/^-?\d+(\.\d+)?$/.test(raw)) return { num: Number(raw), qual: '' };
  var m = /^(\d+(?:\.\d+)?)\((.*)\)$/.exec(raw);
  if (m) return { num: Number(m[1]), qual: m[2] };
  return { num: '', qual: raw };
}

function flag_(num, lo, hi) {
  if (num === '') return '';
  if (lo !== '' && num < lo) return 'L';
  if (hi !== '' && num > hi) return 'H';
  return '';
}

// ---- 撮影アプリ用: 追記・一覧 -------------------------------------------

function key_(date, time, item) {
  return [date, time, item].join('|');
}

// rows: [{検査日, 到着時間, 区分, 項目名, 値, 定性, 単位, 基準下限, 基準上限, 判定, 備考, 元ファイル, ページ}]
// 同じ 検査日+到着時間+項目名 が既にあれば追加せず skipped に数える
function append_(rows) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_RECORD);
    var last = sh.getLastRow();
    var seen = {};
    if (last > 1) {
      sh.getRange(2, 1, last - 1, 4).getValues().forEach(function (r) {
        seen[key_(r[0], r[1], r[3])] = true;
      });
    }
    var now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
    var out = [];
    var skipped = 0;
    rows.forEach(function (r) {
      var k = key_(r['検査日'], r['到着時間'], r['項目名']);
      if (seen[k]) { skipped++; return; }
      seen[k] = true;
      out.push(HEADERS.slice(0, 13).map(function (h) { return r[h] === undefined ? '' : r[h]; }).concat([now]));
    });
    if (out.length) {
      sh.getRange(last + 1, 1, out.length, 2).setNumberFormat('@');
      sh.getRange(last + 1, 1, out.length, HEADERS.length).setValues(out);
    }
    return { ok: true, added: out.length, skipped: skipped };
  } finally {
    lock.releaseLock();
  }
}

function list_() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_RECORD);
  var last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, HEADERS.length).getValues().map(function (r) {
    var o = {};
    HEADERS.forEach(function (h, i) { o[h] = r[i]; });
    return o;
  });
}

// 「情報」シートのA列の項目名で値を探す(APIKEY・モデル等。アプリ側の読み取り機能で使う)
function info_(name) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('情報');
  var vals = sh.getDataRange().getValues();
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][0]).trim() === name) {
      if (!vals[i][1]) throw new Error('情報シートの' + name + 'が空です');
      return String(vals[i][1]).trim();
    }
  }
  throw new Error('情報シートに' + name + 'がありません');
}
