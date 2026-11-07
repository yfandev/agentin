'use strict';

// Parse the exact paste format used by the Agent Desk.
// Returns { data, errors }. Nothing is saved here.

function parsePostFormat(text) {
  const lines = String(text || '').split(/\r?\n/);
  const fields = { TITLE: '', CATEGORY: '', POST: '', Q1: '', Q2: '', ANSWER: '' };
  const options = { q1: [], q2: [] };
  const answers = { q1: '', q2: '' };
  const errors = [];
  let current = null;
  let lastQuestion = null;
  let inAnswer = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const kv = line.match(/^(TITLE|CATEGORY|POST|Q1|Q2|ANSWER)\s*:\s*(.*)$/i);
    if (kv) {
      const key = kv[1].toUpperCase();
      const value = kv[2].trim();
      if (key === 'Q1' || key === 'Q2') {
        lastQuestion = key.toLowerCase();
        fields[key] = value;
        current = key;
        inAnswer = false;
      } else if (key === 'ANSWER') {
        if (lastQuestion) answers[lastQuestion] = value;
        inAnswer = true;
        current = null;
      } else {
        fields[key] = value;
        current = key;
        inAnswer = false;
      }
      continue;
    }

    if (/^[A-D]\)/.test(line)) {
      if (!lastQuestion || inAnswer) {
        errors.push('OPTIONS: option lines must come under Q1 or Q2, before ANSWER.');
        continue;
      }
      const re = /([A-D])\)\s*([\s\S]*?)(?=\s+[A-D]\)\s*|$)/g;
      let m;
      while ((m = re.exec(line))) {
        const letter = m[1].toLowerCase();
        const idx = ['a', 'b', 'c', 'd'].indexOf(letter);
        options[lastQuestion][idx] = m[2].trim();
      }
      continue;
    }

    if (current) {
      fields[current] = (fields[current] ? fields[current] + ' ' : '') + line;
    }
  }

  if (!fields.TITLE) errors.push('TITLE: missing. Add a line starting with “TITLE:”.');
  if (!fields.CATEGORY) errors.push('CATEGORY: missing. Add a line starting with “CATEGORY:”.');
  if (!fields.POST) errors.push('POST: missing. Add a line starting with “POST:”.');
  ['q1', 'q2'].forEach((qk, i) => {
    const n = i + 1;
    if (!fields['Q' + n]) errors.push(`Q${n}: missing. Add a line starting with “Q${n}:”.`);
    const opts = options[qk];
    ['A', 'B', 'C', 'D'].forEach((letter, idx) => {
      if (!opts[idx]) errors.push(`Q${n} option ${letter}: missing. Use “${letter}) …”.`);
    });
    if (!answers[qk]) errors.push(`Q${n} ANSWER: missing. Add a line starting with “ANSWER:”.`);
  });

  return {
    errors,
    data: {
      title: fields.TITLE,
      category: fields.CATEGORY,
      body: fields.POST,
      q1: { prompt: fields.Q1, options: options.q1, answer: answers.q1 },
      q2: { prompt: fields.Q2, options: options.q2, answer: answers.q2 },
    },
  };
}

module.exports = { parsePostFormat };
