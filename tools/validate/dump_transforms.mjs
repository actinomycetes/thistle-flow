import { makeTransform } from '../../js/transforms.js';
const params = [[262144, 0.5, 4.5, 0], [262144, 1, 4.5, 0], [262144, 0, 4.5, 0], [10000, 0.5, 4.5, 0.5], [1e6, 1.5, 5.5, 0], [262144, 2, 4.5, 0], [262144, 0.3, 4.5, -0.2]];
const xs = []; for (const v of [-5000, -1000, -100, -10, -1, -0.01, 0, 0.01, 0.5, 1, 7, 10, 50, 100, 333, 1000, 4567, 10000, 50000, 100000, 262144, 300000, 1e6]) xs.push(v);
for (let i = 0; i < 400; i++) xs.push(Math.sinh(-6 + 18 * i / 399) * 10);
const out = params.map(([T, W, M, A]) => { const t = makeTransform({ kind: 'logicle', T, W, M, A }); return { T, W, M, A, fwd: xs.map(x => t.fwd(x)), inv: xs.map(x => t.inv(t.fwd(x))) }; });
const as = [5, 150, 1000].map(cof => { const t = makeTransform({ kind: 'arcsinh', cofactor: cof, min: -1000, max: 262144 }); return { cof, fwd: xs.map(x => t.fwd(x)) }; });
console.log(JSON.stringify({ xs, out, as }));
