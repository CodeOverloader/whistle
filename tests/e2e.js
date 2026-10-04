const { chromium } = (() => { try { return require('playwright'); } catch (e) { return require('/opt/node-tools/node_modules/playwright'); } })();
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');

const server = http.createServer((q, s) => {
  const f = path.join(ROOT, q.url === '/' ? 'index.html' : q.url.split('?')[0]);
  fs.readFile(f, (e, d) => { if (e) { s.writeHead(404); s.end(); } else { s.writeHead(200); s.end(d); } });
});

// Mock CSVs keyed by sheet gid (see TABS in index.html)
const CSV = {
  1551199969: 'first name,last name,date,time,role,field,age,pay\n',
  1934412306: 'last,first,x,total\ndoe,jane,,$50\n',
  1490026671: 'date,start time,field name,division name,home name,away name,CR 1,CR 2,AR 1,AR2,game cancelled\n2026-11-02,9:00 AM,Field 1,U10 Boys,Reds,Blues,Jane Doe,,,,FALSE\n',
  2003177213: 'name,date,start time,end time,allocation,hours,role,pay\n',
  581916481: 'age,cr,ar\nu10,$30,$20\n',
  743456320: 'age,cr,ar\n',
};

let results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${extra}`); };

(async () => {
  await new Promise(r => server.listen(0, r));
  const url = `http://localhost:${server.address().port}/`;
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  let online = true; const requested = [];
  await ctx.route('**/docs.google.com/**', route => {
    if (!online) return route.abort('internetdisconnected');
    const u = new URL(route.request().url());
    requested.push(u.pathname);
    const gid = u.searchParams.get('gid');
    route.fulfill({ status: 200, contentType: 'text/csv', body: CSV[gid] });
  });

  // 1. Online import
  await page.goto(url);
  await page.waitForFunction(() => document.getElementById('sheetStatus').textContent === 'CONNECTED');
  check('online: status CONNECTED', true);
  check('online: cache written to localStorage', await page.evaluate(() => !!localStorage.getItem('whistle-cache-v2')));

  // 2. Name saving
  await page.fill('#firstName', 'Jane');
  await page.fill('#lastName', 'Doe');
  await page.reload();
  await page.waitForFunction(() => document.getElementById('sheetStatus').textContent !== 'FETCHING…');
  const fn = await page.inputValue('#firstName'), ln = await page.inputValue('#lastName');
  check('name persists across reload', fn === 'Jane' && ln === 'Doe', `(got "${fn}" "${ln}")`);

  // 3. Fallback: fetch fails, cache exists
  online = false;
  await page.reload();
  await page.waitForFunction(() => document.getElementById('sheetStatus').textContent !== 'FETCHING…');
  check('offline+cache: status OFFLINE', (await page.textContent('#sheetStatus')) === 'OFFLINE', `(${await page.textContent('#sheetStatus')})`);
  check('offline+cache: CACHED note shown', (await page.innerHTML('#cacheNote')).includes('CACHED'));

  // 4. Fallback: fetch fails, no cache
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForFunction(() => document.getElementById('sheetStatus').textContent !== 'FETCHING…');
  check('offline+no cache: status ERROR', (await page.textContent('#sheetStatus')) === 'ERROR');

  // 5. Fallback with a corrupt cache
  await page.evaluate(() => localStorage.setItem('whistle-cache-v2', '{not json'));
  await page.reload();
  await page.waitForFunction(() => document.getElementById('sheetStatus').textContent !== 'FETCHING…');
  check('offline+corrupt cache: ERROR, no crash', (await page.textContent('#sheetStatus')) === 'ERROR');

  // 6. Import source is configurable at any time (not only on failure)
  online = true;
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForFunction(() => document.getElementById('sheetStatus').textContent === 'CONNECTED');
  check('default sheet used initially', requested[requested.length - 1].includes('1d528hMOpZDq4nS'));
  await page.fill('#sheetSource', 'not a sheet');
  await page.click('#saveSourceBtn');
  check('invalid source rejected', (await page.textContent('#sourceMsg')).includes('Not a valid'));
  const NEW = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123';
  await page.fill('#sheetSource', `https://docs.google.com/spreadsheets/d/${NEW}/edit#gid=0`);
  await page.click('#saveSourceBtn');
  await page.waitForFunction(() => document.getElementById('sheetStatus').textContent === 'CONNECTED');
  check('saved link is used immediately while online', requested[requested.length - 1].includes(NEW));
  await page.reload();
  await page.waitForFunction(() => document.getElementById('sheetStatus').textContent === 'CONNECTED');
  check('saved source used on next load', requested[requested.length - 1].includes(NEW) && (await page.inputValue('#sheetSource')) === NEW);
  online = false;
  await page.reload();
  await page.waitForFunction(() => document.getElementById('sheetStatus').textContent !== 'FETCHING…');
  check('fallback uses cache of the configured sheet', (await page.textContent('#sheetStatus')) === 'OFFLINE');
  await page.evaluate(() => localStorage.removeItem('whistle-cache-v2'));
  await page.click('#resetSourceBtn');
  await page.waitForFunction(() => document.getElementById('sheetStatus').textContent !== 'FETCHING…');
  check('reset: default sheet has no cache, so ERROR rather than other sheet data', (await page.textContent('#sheetStatus')) === 'ERROR');

  // 7. Weekend games in assorted sheet formats must be found and dated
  const variants = await page.evaluate(() => {
    const H = 'date,start time,field name,division name,home name,away name,CR 1,CR 2,AR 1,AR2,game cancelled';
    const cases = [
      ['2026-10-03', 'Jane Doe'], ['10/3/2026', 'Jane Doe'], ['Sat 10/3/2026', 'Jane Doe'],
      ['"Saturday, October 3, 2026"', 'Jane Doe'], ['Oct 3', 'Jane Doe'], ['10/3', 'Jane Doe'],
      ['10/3/2026', 'Jane  Doe'], ['10/3/2026', 'Jane\u00a0Doe'], ['10/3/2026', 'Jane Doe (M)'], ['10/3/2026', '"Doe, Jane"'],
    ];
    return cases.map(([d, n]) => {
      const data = { payroll: parseCSV('first name,last name,date,time,role,field,age,pay'), payrollSummary: parseCSV('l,f,x,t'),
        hourly: parseCSV('name,date,start time,end time,allocation,hours,role,pay'), outdoorPay: parseCSV('age,cr,ar\nu10,$30,$20'), indoorPay: [],
        schedule: parseCSV(`${H}\n${d},9:00 AM,F1,U10 Boys,A,B,${n},,,,FALSE`) };
      const g = buildAssignments(data, 'jane', 'doe').combined[0];
      return { d, n, ok: !!g && !!g.date && g.date.getMonth() === 9 && g.date.getDate() === 3 };
    });
  });
  for (const v of variants) check(`weekend game found: date=${v.d} name=${v.n.replace(/\u00a0/g, '<nbsp>')}`, v.ok);

  // 8. Real sheet headers: "CR1/CR2/AR1/AR2", "Referee First Name", unlabeled cancel checkbox column
  const real = await page.evaluate(() => {
    const data = {
      schedule: parseCSV('date,start time,field name,division name,home name,away name,CR1,CR2,AR1,AR2,FALSE\n' +
        '2026-10-03,8:00 AM,F1,U10 Boys,A,B,carl one,dana two,eve three,fay four,FALSE\n' +
        '2026-10-03,9:00 AM,F1,U10 Boys,A,B,carl one,,,,TRUE'),
      payroll: parseCSV('Date,Time,Field,Age,Role,Referee First Name,Referee Last Name,Type,Pay\n2026-10-03,8:00 AM,F1,u10,AR,eve,three,Ref,31'),
      payrollSummary: parseCSV('l,f,t,total'), hourly: parseCSV('date,Start Time,End time,Name,Role,Hours,Pay,Allocation'),
      outdoorPay: parseCSV('age,cr,ar\nu10,$30,$20'), indoorPay: [],
    };
    const find = (f, l) => buildAssignments(data, f, l);
    return {
      cr1: find('carl', 'one').combined.length, cr2: find('dana', 'two').combined.length,
      ar1: find('eve', 'three').combined[0]?.confirmed, ar2: find('fay', 'four').combined.length,
      cancelled: find('carl', 'one').cancelled.length,
    };
  });
  check('CR1, CR2, AR1, AR2 columns all matched', real.cr1 === 1 && real.cr2 === 1 && real.ar1 === true && real.ar2 === 1, JSON.stringify(real));
  check('unlabeled cancel column detected', real.cancelled === 1);

  await browser.close(); server.close();
  process.exit(results.every(Boolean) ? 0 : 1);
})();
