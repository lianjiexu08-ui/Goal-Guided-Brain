// Owner-side acceptance oracle, outside the model's development workspace.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const { summarizeTransactions } = await import(
  pathToFileURL(process.argv[2]).href
);
const input = [
  { date: '2024-02-29', amount: '0.10' },
  { date: '2024-02-01', amount: '0.20' },
  { date: '2024-02-20', amount: '-0.07' },
  { date: '2023-12-31', amount: '-2.50' },
];
const original = structuredClone(input);
assert.deepEqual(summarizeTransactions(input), [
  { month: '2023-12', incomeCents: 0, expenseCents: 250, balanceCents: -250 },
  { month: '2024-02', incomeCents: 30, expenseCents: 7, balanceCents: 23 },
]);
assert.deepEqual(input, original);
assert.deepEqual(summarizeTransactions([]), []);
for (const date of [
  '2023-02-29',
  '2024-04-31',
  '2024-13-01',
  '2024-00-01',
  '2024-02-00',
  '2024-2-01',
  '2024-02-29\n',
  'garbage',
])
  assert.throws(() => summarizeTransactions([{ date, amount: '1.00' }]));
for (const amount of [
  '1',
  '1.2',
  '1.234',
  'NaN',
  '1e3',
  ' 1.00',
  '1.00\n',
  '900719925474099.00',
  1.25,
])
  assert.throws(() => summarizeTransactions([{ date: '2024-01-01', amount }]));
assert.throws(() => summarizeTransactions(null));
assert.throws(() => summarizeTransactions([null]));
assert.throws(() =>
  summarizeTransactions([
    { date: '2024-01-01', amount: '90071992547409.91' },
    { date: '2024-01-01', amount: '0.01' },
  ]),
);
assert.deepEqual(
  summarizeTransactions([{ date: '2024-01-01', amount: '-0.00' }]),
  [{ month: '2024-01', incomeCents: 0, expenseCents: 0, balanceCents: 0 }],
);
console.log(
  'Owner acceptance passed: exact cents, chronological months, valid dates, invalid inputs, overflow, zero and no mutation.',
);
