// 計算引擎（與舊版試算表公式逐筆比對過）：純計算，不碰儲存。日期用試算表序號（1899-12-30 起算的天數）。
const ENG_BOND_ETF_FREE_TO = 50405;   // 2037-12-31 前一天以前（被動式債券 ETF 停徵證交稅，延長案假設通過至 2036-12-31）
const ENG_KIND = {'現金增資': '買進'};   // 新項目在計算上比照的項目

function eng_rd_(x, n) {                 // Sheets 的 ROUNDDOWN（朝 0）
  const p = Math.pow(10, n || 0);
  const v = Number((x * p).toPrecision(15));
  return Math.trunc(v) / p;
}
function eng_ru_(x, n) {                 // Sheets 的 ROUNDUP（遠離 0）
  const p = Math.pow(10, n || 0);
  const v = Number((x * p).toPrecision(15));
  return (v < 0 ? -Math.ceil(-v) : Math.ceil(v)) / p;
}
function eng_rnd_(x) { const v = Number(x.toPrecision(15)); return v < 0 ? -Math.round(-v) : Math.round(v); }
function eng_sum_(a) { let s = 0; a.forEach(x => s += x); return s; }

// FIFO：從 lots（含 a=調整後股數）扣掉之前已平倉的 S 股，再吃掉這次的 D 股
function eng_take_(lots, S, D) {
  let cum = 0;
  const big = [];
  lots.forEach(l => { cum += l.a; if (cum > S + 1e-9) big.push({l: l, start: cum - S}); });
  if (!big.length) return null;
  const left = big.map(b => D - b.start);
  let last = null;
  left.forEach(v => { if (v <= 1e-9 && (last === null || v > last)) last = v; });
  if (last === null) return null;                       // 庫存不夠扣（公式會出錯）
  const m = left.filter(v => v >= last - 1e-9).length;
  const w = big.slice(0, m);
  let eaten, invLeft;
  if (m === 1) { eaten = [D]; invLeft = [w[0].start]; }
  else {
    eaten = [w[0].start].concat(w.slice(1, m - 1).map(b => b.l.a), [w[m - 1].l.a + last]);
    invLeft = [w[0].start].concat(w.slice(1).map(b => b.l.a));
  }
  return {big: big.map(b => b.l), w: w.map(b => b.l), eaten: eaten, invLeft: invLeft, ratio: eaten.map((e, i) => e / w[i].l.a)};
}
// 依序把 start 這個金額分配到 amounts（超過的部分為 0）
function eng_cap_(amounts, start) {
  let q = 0;
  return amounts.map(x => { const qs = q; q += x; return Math.min(q, start) - Math.min(qs, start); });
}

// cfg: {fees:[{d:序號(啟用日-1), disc}], minFee, minOdd, mp, ss, si, sf, mi, custom:{名稱:{broker, fee, tax}}, nhi:true, today, histDate}
// inputs: [{row, d, item, name, units, price, custom, adj, cr, dt}]
function eng_compute_(inputs, cfg) {
  const R = inputs.map(x => Object.assign({}, x));
  const ok = R.filter(r => typeof r.d === 'number' && r.item && r.name && /（.+）$/.test(r.name));
  ok.sort((a, b) => a.d - b.d || a.row - b.row);
  const byName = {}, uid = {}, dayKey = {};
  const U = (r) => { const k = r.name + '_' + r.J; return uid[k] || (uid[k] = {k: k, name: r.name, batch: r.J, rows: [], spot: [], mt: [], ss: [], P: 1, AG: 0, AH: 0, AI: 0, sClosed: 0, mClosed: 0, qClosed: 0, mc: []}); };
  const allow = d => {
    let best = null;
    cfg.fees.forEach(f => { if (d > f.d && (best === null || f.d > best.d)) best = f; });
    return best ? best.disc / 10 : 1;
  };
  const defFee = (amt, d, item, unit, al) => {
    const a = al === '' ? allow(d) : al;
    const t = eng_rd_(amt * 1.425 / 1000 * a);
    if (['折讓', '存款利息', '股票股利', '股票分割', '股票反分割', '融資現償', '保證金追繳', '現金增資'].indexOf(item) >= 0) return 0;
    if (item === '現金股利') return 10;
    if (t >= cfg.minFee) return t;
    if (t >= cfg.minOdd) return unit >= 1000 ? cfg.minFee : t;
    return cfg.minOdd;
  };

  ok.forEach(r => {
    const N = byName[r.name] || (byName[r.name] = {last: null, maxB: 0, maxBuy: 0, maxMT: 0, maxSS: 0});
    const item = r.item, kind = ENG_KIND[item] || item, D = r.units, E = r.price;
    const prev = N.last;
    r.L = prev ? prev.G : 0; r.M = prev ? prev.H : 0; r.N = prev ? prev.I : 0;
    // 庫存
    r.G = ['買進', '股票股利', '融資現償'].indexOf(kind) >= 0 ? r.L + D : kind === '賣出' ? r.L - D :
      kind === '股票分割' ? r.L * D : kind === '股票反分割' ? r.L / D : r.L;
    r.H = kind === '融資買進' ? r.M + D : (kind === '融資賣出' || kind === '融資現償') ? r.M - D :
      kind === '股票分割' ? r.M * D : kind === '股票反分割' ? r.M / D : r.M;
    r.I = kind === '融券賣出' ? r.N + D : kind === '融券買進' ? r.N - D :
      kind === '股票分割' ? r.N * D : kind === '股票反分割' ? r.N / D : r.N;
    const dtClose = (r.G < 0 && (kind === '買進' || kind === '賣出')) || (r.G === 0 && kind === '買進');
    r.F = dtClose ? r.G :
      (['買進', '融資買進', '股票股利', '股票分割', '股票反分割', '現金股利', '賣出', '融資賣出', '融資現償', '保證金追繳'].indexOf(kind) >= 0 ? Math.max(r.G, 0) + r.H : 0) +
      (['融券賣出', '融券買進', '保證金追繳'].indexOf(kind) >= 0 ? r.I : 0);
    // 批號
    const dk = r.name + '|' + r.d, DK = dayKey[dk] || (dayKey[dk] = {dt: 0, sell: 0});
    if (r.dt) r.J = DK.dt > 0 ? DK.dt : N.maxB + 1;
    else if ((['買進', '融資買進', '融券賣出'].indexOf(kind) >= 0 && r.F === D) || (kind === '賣出' && r.F === -D)) r.J = N.maxB + 1;
    else if (dtClose) r.J = DK.sell;
    else if (['買進', '融資買進', '賣出', '融資賣出', '現金股利', '股票股利', '股票分割', '股票反分割', '融資現償'].indexOf(kind) >= 0 || (kind === '保證金追繳' && r.H !== 0)) r.J = Math.max(N.maxBuy, N.maxMT);
    else if (kind === '融券買進' || kind === '融券賣出' || (kind === '保證金追繳' && r.I !== 0)) r.J = N.maxSS;
    else r.J = 0;
    r.K = r.row;
    r.O = ['股票股利', '融資現償', '保證金追繳'].indexOf(kind) >= 0 ? 0 : eng_rd_(E * D);
    const u = U(r);
    if (kind === '股票分割') u.P *= D; else if (kind === '股票反分割') u.P /= D;
    r.P = u.P;
    r.T = (r.name.match(/（(.+)）$/) || [])[1] || '';
    // 手續費
    const cu = r.custom ? cfg.custom[r.custom] : null;
    if (!cu || cu.fee === '' || cu.fee === null || cu.fee === undefined) r.S = defFee(r.O, r.d, item, D, '');
    else if (cu.broker) r.S = defFee(r.O, r.d, item, D, cu.fee);
    else r.S = cu.fee >= 1 ? cu.fee : r.O * cu.fee;
    // 交易稅
    const sameDay = (u.day && u.day[r.d]) || {b: 0, s: 0};
    const defTax = () => {
      if (['賣出', '融券賣出', '融資賣出'].indexOf(kind) < 0) return 0;
      const s = r.T;
      if (/^00\d+B$/.test(s) && r.d <= ENG_BOND_ETF_FREE_TO) return 0;
      if (s.charAt(0) === '0' || (s.charAt(0) === '9' && s.length === 6)) return eng_rd_(r.O * 0.001);
      const half = D >= 1000 && (r.F < 0 || (kind === '賣出' && (sameDay.b - sameDay.s) >= D));
      return eng_rd_(r.O * 0.003 * (half ? 0.5 : 1));
    };
    if (!cu || cu.tax === '' || cu.tax === null || cu.tax === undefined) r.U = defTax();
    else r.U = cu.tax >= 1 ? cu.tax : r.O * cu.tax;
    // 二代健保
    r.V = 0;
    if (cfg.nhi !== false && kind === '現金股利' && r.O >= 20000 && new Date(Date.UTC(1899, 11, 30) + r.d * 864e5).getUTCFullYear() >= 2021)
      r.V = r.O > 10000000 ? 10000000 * 0.0211 : eng_rnd_(r.O * 0.0211);
    r.W = kind === '融券賣出' ? eng_rd_(r.O * cfg.sf) : 0;

    const noMC = !u.mc.length;
    const mtAfter = (t) => {                     // 追繳後各批實際剩餘的融資金額（只取這次吃到的批）
      if (noMC) return t.w.map(l => l.AA);
      const after = eng_cap_(t.big.map(l => l.AA), u.AI);
      return after.slice(0, t.w.length);
    };
    // 利息、擔保品、保證金、融資金額、現償成本
    r.X = 0; r.Y = 0; r.Z = 0; r.AA = 0; r.AB = 0; r.Q = 0;
    let tMT = null, tSS = null;
    if (kind === '融資賣出' || kind === '融資現償') tMT = eng_take_(u.mt, u.mClosed, D);
    if (kind === '融券買進') tSS = eng_take_(u.ss, u.qClosed, D);
    if (kind === '融券買進' && tSS) {
      const mcAmt = eng_sum_(u.mc.map(m => m.E * (r.d - m.d) * cfg.si / 365));
      r.X = eng_ru_(eng_sum_(tSS.w.map((l, i) => (l.Z + l.Y) * cfg.si * tSS.ratio[i] * ((r.d - l.d) / 365))) + mcAmt);
    } else if (kind === '保證金追繳' && r.H !== 0) {
      const t = eng_take_(u.mt, u.mClosed, D);
      if (t) {
        const rev = t.w.map(l => l.AA).reverse();
        const alloc = eng_cap_(rev, E).reverse();
        r.X = eng_ru_(-eng_sum_(alloc.map((a, i) => a * cfg.mi * ((r.d - t.w[i].d) / 365))));
      }
    } else if (tMT) {
      const after = mtAfter(tMT);
      r.X = eng_ru_(-eng_sum_(after.map((a, i) => a * cfg.mi * tMT.ratio[i] * ((r.d - tMT.w[i].d) / 365))));
    }
    if (kind === '融券賣出') r.Y = r.O - r.S - r.U - r.V - r.W;
    if (kind === '融券買進' && tSS) r.Y -= eng_sum_(tSS.w.map((l, i) => l.Y * tSS.ratio[i]));
    if (kind === '融券賣出') r.Z = eng_ru_(r.O * (cfg.ss + (r.cr || 0)) / 10, -2);
    else if (kind === '保證金追繳' && r.I !== 0) r.Z = E;
    if (kind === '融券買進' && tSS) r.Z -= eng_sum_(tSS.w.map((l, i) => l.Z * tSS.ratio[i])) + (r.I === 0 ? eng_sum_(u.mc.map(m => m.E)) : 0);
    let aa = kind === '融資買進' ? eng_rd_((cfg.mp + (r.cr || 0)) / 10 * r.O, -3) : (kind === '保證金追繳' && r.H !== 0) ? -E : 0;
    if (tMT) aa += -eng_sum_(mtAfter(tMT).map((a, i) => a * tMT.ratio[i]));
    r.AA = eng_rd_(aa);
    r.AC = Number(r.adj) || 0;
    // 淨金額（融資現償的成本要先有 X，淨金額也要用到 AB 之前的值）
    const nets = (sign) => sign * r.O - r.S - r.U - r.V - r.W + r.X + r.AA + r.AC;
    r.AD = (['融券買進', '融券賣出', '保證金追繳'].indexOf(kind) >= 0 ? -r.Y - r.Z : 0) +
      nets((kind === '融券買進' ? -1 : 1) * ((kind === '買進' || kind === '融資買進') ? -1 : 1));
    if (kind === '融資現償' && tMT) r.AB = eng_rd_(eng_sum_(tMT.w.map((l, i) => (-l.AD + l.AA) * tMT.ratio[i])) - r.X);
    // FIFO 投入成本
    if (cfg.fifo && (kind === '賣出' || kind === '融資賣出')) {
      const t = kind === '賣出' ? eng_take_(u.spot, u.sClosed, D) : tMT;
      if (t) {
        const after = mtAfter(t);
        const mtA = t.w.map(l => l.AA || 0);
        const diff = noMC ? mtA.map(() => 0) : mtA.map((a, i) => a * (t.invLeft[i] / t.w[i].a) - after[i]);
        let mcInt = 0;
        if (!noMC) {
          const before = eng_sum_(mtA.map((a, i) => a * t.ratio[i])), aft = eng_sum_(after.map((a, i) => a * t.ratio[i]));
          const rev = u.mc.slice().reverse();
          const eatenRev = eng_cap_(rev.map(m => m.E), before - aft);
          mcInt = -eng_sum_(rev.map((m, i) => m.X * (eatenRev[i] / m.E)));
        }
        r.Q = eng_rd_(eng_sum_(t.w.map((l, i) => ((l.AB === 0 ? -l.AD : l.AB) + diff[i]) * t.ratio[i])) + mcInt);
      } else r.Q = '';
    }
    // 累計
    u.AG += r.Y; u.AH += r.Z; const prevAI = u.AI; u.AI += r.AA;
    r.AG = u.AG; r.AH = u.AH; r.AI = u.AI; r._prevAI = prevAI;
    // 加入／移出各佇列
    const lot = {r: r, d: r.d, p: u.P, u: D, AD: r.AD, AA: r.AA, AB: r.AB, Y: r.Y, Z: r.Z, a: D};
    if (['買進', '融資現償', '股票股利'].indexOf(kind) >= 0) u.spot.push(lot);
    if (kind === '融資買進') u.mt.push(lot);
    if (kind === '融券賣出') u.ss.push(lot);
    if (kind === '賣出') u.sClosed += D;
    if (kind === '融資賣出' || kind === '融資現償') u.mClosed += D;
    if (kind === '融券買進') u.qClosed += D;
    if (kind === '股票分割' || kind === '股票反分割') {
      const f = kind === '股票分割' ? D : 1 / D;
      [u.spot, u.mt, u.ss].forEach(q => q.forEach(l => l.a *= f));
      u.sClosed *= f; u.mClosed *= f; u.qClosed *= f;
    }
    if (kind === '保證金追繳') u.mc.push({d: r.d, E: E, X: r.X, ss: r.I !== 0, r: r});
    // 庫存成本（FIFO）
    const lb = (q, closed, unit, type) => {
      const t = eng_take_(q, closed, unit);
      if (!t) return null;
      if (type === 'spot') return -eng_sum_(t.w.map((l, i) => (l.AB !== 0 ? -l.AB : l.AD) * t.ratio[i]));
      if (type === 'mt') return eng_sum_(t.w.map((l, i) => l.AA * t.ratio[i])) - eng_sum_(t.w.map((l, i) => l.AD * t.ratio[i]));
      return eng_sum_(t.w.map((l, i) => l.Y * t.ratio[i]));
    };
    let af = 0, bad = false;
    if (r.I !== 0 && (kind === '融券買進' || kind === '融券賣出')) { const v = lb(u.ss, u.qClosed, r.I, 'ss'); if (v === null) bad = true; else af = v; }
    else {
      if (r.G !== 0) { const v = lb(u.spot, u.sClosed, r.G, 'spot'); if (v === null) bad = true; else af += v; }
      if (r.H !== 0) { const v = lb(u.mt, u.mClosed, r.H, 'mt'); if (v === null) bad = true; else af += v; }
    }
    r.AF = bad ? '' : eng_rd_(af);
    r.AE = r.F === 0 || bad ? 0 : r.AF / r.F;
    // 更新索引
    if (u.day === undefined) u.day = {};
    const sd = u.day[r.d] || (u.day[r.d] = {b: 0, s: 0});
    if (kind === '買進') sd.b += D; if (kind === '賣出') sd.s += D;
    N.last = r;
    N.maxB = Math.max(N.maxB, r.J);
    if (kind === '買進' && r.F !== 0 && !r.dt) N.maxBuy = Math.max(N.maxBuy, r.J);
    if (kind === '融資買進') N.maxMT = Math.max(N.maxMT, r.J);
    if (kind === '融券賣出') N.maxSS = Math.max(N.maxSS, r.J);
    if (r.dt) DK.dt = Math.max(DK.dt, r.J);
    if (kind === '賣出') DK.sell = Math.max(DK.sell, r.J);
    u.rows.push(r);
    r._u = u; r._kind = kind;
  });

  // 利息試算（需要之後的平倉資料）
  ok.forEach(r => {
    const kind = r._kind, u = r._u;
    r.AK = 0;
    if (kind === '保證金追繳' && r.I !== 0) {
      const closed = u.rows.slice(u.rows.indexOf(r)).filter(x => x.I === 0).map(x => x.d);
      const close = Math.min.apply(null, closed.concat([cfg.today]));
      r.AK = eng_ru_(r.Z * cfg.si * (close - r.d) / 365);
    } else if (kind === '融券賣出' || kind === '融資買進') {
      const isSS = kind === '融券賣出';
      const thisU = isSS ? r.Z : r.AA;
      if (!thisU) return;
      const inv = isSS ? r.AH : r.AI;
      const idx = u.rows.indexOf(r);
      const closes = u.rows.slice(idx).filter(x => isSS ? x._kind === '融券買進' : ['融資賣出', '融資現償', '保證金追繳'].indexOf(x._kind) >= 0);
      const qs = inv - thisU;
      let acc = 0;
      const w = [];
      closes.forEach(x => { acc += Math.abs(isSS ? x.Z : x.AA); if (acc > qs) w.push({d: x.d, acc: acc}); });
      const dates = [r.d].concat(w.map(x => x.d), [cfg.today]);
      const iv = []; for (let i = 1; i < dates.length; i++) iv.push(dates[i] - dates[i - 1]);
      const left = [thisU].concat(w.map(x => Math.max(0, thisU + qs - x.acc)));
      const amt = isSS ? (r.Y + r.Z) * cfg.si : r.AA * cfg.mi;
      r.AK = eng_ru_(amt * eng_sum_(left.map((v, i) => v * iv[i])) / thisU / 365);
    }
  });
  return {rows: R, ok: ok, uids: uid, byName: byName};
}

// 由計算結果整理出各分頁的內容
function eng_views_(res, cfg) {
  const ok = res.ok;
  const phys = ok.slice().sort((a, b) => a.row - b.row);
  // 總投資績效：每個 名稱_批號
  const uids = Object.keys(res.uids).map(k => res.uids[k]).filter(u => u.batch !== 0 && u.batch !== '');
  uids.sort((a, b) => a.k < b.k ? -1 : a.k > b.k ? 1 : 0);
  uids.forEach(u => { u.first = u.rows.reduce((m, r) => r.row < m.row ? r : m, u.rows[0]); });
  uids.sort((a, b) => a.first.d - b.first.d);           // 依建倉日期（穩定排序）
  const sumNet = (u, f) => eng_sum_(u.rows.filter(f).map(r => r.AD));
  // 已實現
  const realized = phys.filter(r => (r._kind === '賣出' && r.F >= 0) || r._kind === '融資賣出' || r._kind === '融券買進' || (r._kind === '買進' && r.F <= 0)).map(r => {
    const u = r._u;
    const prevAvg = u.rows.filter(x => x.row < r.row && x.AE !== '').pop();
    const N = prevAvg ? prevAvg.AE : '';
    const O = r._kind === '融券買進' ? -r.Z : (cfg.fifo ? (r.Q === '' ? 0 : r.Q) : N * r.units + r.AA);
    const Q = r._kind === '融資現償' ? r.X : r.AD - O * (r._kind === '買進' ? -1 : 1);
    return {r: r, N: N, O: O, P: O ? Q / O : '', Q: Q};
  });
  let cum = 0; realized.forEach(x => { cum += x.Q; x.R = cum; });
  const realByUid = {};
  realized.forEach(x => realByUid[x.r._u.k] = (realByUid[x.r._u.k] || 0) + x.Q);
  const perf = uids.map(u => {
    const nonDT = u.rows.filter(r => !r.dt);
    // 「最後一筆」要照日期先後（同一天才看輸入順序），不能只看編號：補記較早日期的紀錄（例如股利）編號會比較大
    const later = (r, m) => r.d > m.d || (r.d === m.d && r.row > m.row);
    const lastND = nonDT.length ? nonDT.reduce((m, r) => later(r, m) ? r : m) : null;
    const hold = !!(lastND && lastND.F > 0);
    const G = -sumNet(u, r => (r._kind === '買進' && r.F > 0) || r._kind === '融券賣出' || r._kind === '融資買進' || r._kind === '融資現償') +
      sumNet(u, r => r._kind === '賣出' && r.F < 0);
    const H = sumNet(u, r => r._kind === '現金股利');
    const I = sumNet(u, r => (r._kind === '賣出' && r.F >= 0) || r._kind === '融券買進' || r._kind === '融資賣出') - sumNet(u, r => r._kind === '買進' && r.F <= 0);
    const K = realByUid[u.k] || 0;
    const last = u.rows.reduce((m, r) => later(r, m) ? r : m);
    return {u: u, name: u.name, batch: u.batch, code: (u.name.match(/（(.+)）$/) || [])[1], first: u.first.d, hold: hold,
      G: G, H: H, I: I, J: K >= 0 ? I - K : I, K: K, start: Math.min.apply(null, u.rows.map(r => r.d)), end: Math.max.apply(null, u.rows.map(r => r.d)), last: last};
  });
  // 未實現：有庫存的
  const unreal = perf.filter(p => p.hold).map(p => {
    const u = p.u, last = p.last;
    const short = u.rows.some(r => r.AH !== 0);
    const E = last.F;
    // 融資剩餘批（投入資金、到期日）
    let P = 0, mtDue = '';
    if (!short && last.H > 0) {
      const t = eng_take_(u.mt.slice().reverse(), 0, last.H);
      if (t) {
        const ratio = t.ratio, w = t.w;
        let after = w.map(l => l.AA), diff = w.map(() => 0), mcInt = 0;
        if (u.mc.length) {
          after = eng_cap_(w.map(l => l.AA).reverse(), last.AI).reverse();   // 從最舊的批開始分配
          diff = w.map((l, i) => l.AA * (t.invLeft[i] / l.a) - after[i]);
          const before = eng_sum_(w.map((l, i) => l.AA * ratio[i])), aft = eng_sum_(after.map((a, i) => a * ratio[i]));
          const mrev = u.mc.slice().reverse();
          const eatenRev = eng_cap_(mrev.map(m => m.E), before - aft);
          mcInt = -eng_sum_(mrev.map((m, i) => m.X * (eatenRev[i] / m.E)));
        }
        P = -eng_sum_(w.map((l, i) => l.AD * ratio[i] - diff[i])) + mcInt;
        mtDue = Math.min.apply(null, w.map(l => l.d));
      }
    }
    let Qc = 0;
    if (!short && last.G > 0) {
      const t = eng_take_(u.spot.slice().reverse(), 0, last.G);
      if (t) Qc = eng_sum_(t.w.map((l, i) => (l.AB === 0 ? -l.AD : l.AB) * t.ratio[i]));
    }
    const lastByName = res.byName[u.name].last;
    const M = last.AG, Nn = last.AH, O = short ? 0 : last.AI;
    const I = short ? M / E : (Qc + P + O) / E;
    const J = short ? Nn : Qc + P;
    const akSum = eng_sum_(u.rows.map(r => r.AK)), xSum = eng_sum_(u.rows.map(r => r.X));
    const V = eng_ru_(akSum) * (short ? 1 : -1) - eng_ru_(xSum);
    return {p: p, name: u.name, batch: u.batch, code: p.code, E: E, short: short, I: I, J: J, M: M, N: Nn, O: O, P: P, Q: Qc,
      R: short ? 0 : lastByName.H, V: V, mtDue: mtDue};
  });
  // 股票清單
  const names = Object.keys(res.byName);
  const stocks = names.map(n => {
    const N = res.byName[n], last = N.last;
    const held = last.G + last.H;
    const rows = ok.filter(r => r.name === n);
    const lastBuy = rows.filter(r => r._kind === '買進' && r.F !== 0 && !r.dt).pop();
    const lastMT = rows.filter(r => r._kind === '融資買進').pop();
    const lastSS = rows.filter(r => r._kind === '融券賣出').pop();
    const hist = rows.filter(r => r.d <= cfg.histDate).pop();
    return {name: n, code: (n.match(/（(.+)）$/) || [])[1], short: n.replace(/（.+）$/, ''), held: held,
      batch: held !== 0 ? Math.max(lastBuy ? lastBuy.J : 0, lastMT ? lastMT.J : 0) : '',
      ss: last.I, batch2: last.I !== 0 ? (lastSS ? lastSS.J : 0) : '',
      histHeld: hist ? hist.G + hist.H : 0, histSS: hist ? hist.I : 0, first: rows[0].d};
  });
  return {phys: phys, realized: realized, perf: perf, unreal: unreal, stocks: stocks};
}

