import type { Block, Delivery, Message, Note, Repo } from './store.ts';
export const sections = ['Added', 'Changed', 'Fixed', 'Removed', 'Security', 'Deprecated'];
export const intents = ['no-release', 'patch', 'minor', 'major'];
export function parseNotes(text: string): Note[] {
  const notes = JSON.parse(text);
  if (!Array.isArray(notes) || !notes.length || notes.some(n => !sections.includes(n.section) || !Array.isArray(n.bullets) || !n.bullets.length || n.bullets.some((b: unknown) => typeof b !== 'string' || !b.trim()))) throw new Error('notes must be a nonempty JSON array of {section, bullets}');
  return notes;
}
export function composeNotes(deliveries: Delivery[]) {
  const intent = intents[Math.max(0, ...deliveries.map(d => intents.indexOf(d.intent)))];
  if (intent === 'major') throw new Error('park for woksin');
  const body = sections.map(s => {
    const bullets = deliveries.flatMap(d => d.notes.filter(n => n.section === s).flatMap(n => n.bullets));
    return bullets.length ? `## ${s}\n${bullets.map(b => `- ${b}`).join('\n')}` : '';
  }).filter(Boolean).join('\n\n') + '\n';
  return { body, label: `release:${intent}` };
}
export function dependencyOrder(all: Delivery[], ids: string[], satisfied: string[] = []): Delivery[] {
  const ordered: Delivery[] = [], visiting = new Set<string>(), visited = new Set(satisfied);
  const visit = (id: string) => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`dependency cycle: ${id}`);
    const d = all.find(d => d.id === id);
    if (!d) throw new Error(`missing dependency: ${id}`);
    visiting.add(id); d.deps.forEach(visit); visiting.delete(id); visited.add(id); ordered.push(d);
  };
  ids.forEach(visit);
  return ordered;
}
export function dependents(all: Delivery[], dropped: string[]): string[] {
  const set = new Set(dropped);
  let changed = true;
  while (changed) { changed = false; for (const d of all) if (!set.has(d.id) && d.deps.some(id => set.has(id))) { set.add(d.id); changed = true; } }
  return [...set];
}
export function freezeSet(pending: Delivery[], batch: Repo['batch'], time = Date.now(), satisfied: string[] = []) {
  const sorted = [...pending].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  if (!sorted.length || (sorted.length < batch.min && time - Date.parse(sorted[0].createdAt) < batch.ageHours * 3600000)) return [];
  let ids: string[] = [];
  for (const d of sorted) {
    const closure = dependencyOrder(pending, [...ids, d.id], satisfied).map(d => d.id);
    if (closure.length <= batch.max) ids = closure;
  }
  return ids;
}
export const formatMessage = (m: Message) => `[orch ${m.kind} from ${m.from}] ${m.subject}\n${m.body}\n→ ack with order_ack/order_decline (id ${m.id})`;
export const immediateL0 = (m: Message) => ['question', 'escalation', 'idle'].includes(m.kind) || (m.kind === 'report' && m.requiresAck);
export const overdue = (m: Message, time = Date.now(), grace = 0) => time >= Date.parse(m.createdAt) + (m.ackDeadlineMin + grace) * 60000;
export function deliveryBatch(messages: Message[], id: string, has: (msg: string, state: string) => boolean, lastDigest: number, time = Date.now()) {
  const fresh = messages.filter(m => !has(m.id, 'delivered'));
  const immediate = fresh.filter(m => id !== 'L0' || immediateL0(m));
  const digest = id === 'L0' && time - lastDigest >= 600000 ? fresh.filter(m => !immediateL0(m)) : [];
  const reminders = messages.filter(m => m.requiresAck && has(m.id, 'delivered') && !['acked', 'declined', 'done', 'reminded'].some(s => has(m.id, s)) && overdue(m, time));
  return { immediate, digest, reminders };
}
export function holds(messages: Message[], repo?: string): Block[] {
  const active = new Set<Block>();
  for (const m of [...messages].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))) {
    if (m.repo !== repo) continue;
    for (const b of m.blocks || []) { if (m.kind === 'hold') active.add(b); if (m.kind === 'release') active.delete(b); }
  }
  return [...active];
}
// Tokenize executable positions, not quoted prose. Recurse into shell -c payloads and substitutions.
export function commands(text: string): string[][] {
  const tokens = text.match(/'(?:[^']*)'|"(?:\\.|[^"\\])*"|\\.|&&|\|\||[;|&\n()<>]|[^\s;'"|&()<>]+/g) || [];
  const result: string[][] = []; let current: string[] = [];
  const flush = () => { if (current.length) result.push(current); current = []; };
  for (const token of tokens) {
    if (/^(?:&&|\|\||[;|&\n()<>])$/.test(token)) { flush(); continue; }
    const word = token.replace(/^(['"])([\s\S]*)\1$/, '$2').replace(/\\(.)/g, '$1');
    current.push(word);
    if (token.startsWith('"')) for (const sub of word.matchAll(/\$\((.*?)\)|`(.*?)`/g)) result.push(...commands(sub[1] || sub[2]));
  }
  flush();
  return result.flatMap(words => {
    const nested: string[][] = [];
    for (let i = 0; i < words.length; i++) if (/^(?:.*\/)?(?:bash|sh|zsh)$/.test(words[i])) {
      const at = words.findIndex((w, n) => n > i && /^-[a-z]*c[a-z]*$/.test(w));
      if (at >= 0 && words[at + 1]) nested.push(...commands(words[at + 1]));
    }
    return [words, ...nested];
  });
}
function operation(words: string[]): string | undefined {
  let i = words.findIndex(w => /^(?:.*\/)?(?:git|gh)$/.test(w));
  if (i < 0) return;
  // A binary name in echo/printf prose is not executable.
  if (i > 0 && !words.slice(0, i).every(w => /^(?:env|command|exec|sudo|nohup|time|[A-Za-z_][\w]*=.*|-[\w-]+)$/.test(w))) return;
  const binary = words[i++].split('/').at(-1);
  while (words[i]?.startsWith('-')) {
    const flag = words[i++];
    if (['-C', '-c', '--git-dir', '--work-tree', '--repo', '-R', '--hostname'].includes(flag)) i++;
  }
  if (binary === 'git') return words[i] === 'push' ? 'push' : undefined;
  const args = words.slice(i);
  if (args[0] === 'run' && args[1] === 'watch' || args[0] === 'pr' && args[1] === 'checks' && args.some(a => a === '--watch' || a.startsWith('--watch='))) return 'watch';
  if (args[0] === 'pr' && ['create', 'merge', 'ready', 'close'].includes(args[1])) return `pr-${args[1]}`;
  if (args[0] === 'release' || args[0] === 'workflow' && args[1] === 'run') return 'publish';
}
export function guard(command: string, kind: string, primary: boolean, repo: string | undefined, active: Block[]) {
  for (const words of commands(command)) {
    const op = operation(words);
    if (op === 'watch') return 'use orch_status; orch-poll wakes you';
    if (op && (kind === 'lane' || !primary)) return `deliver to R-${repo || '<repo>'}: orch deliver ...`;
    if (kind === 'owner' && active.includes(op as Block)) return `hold for ${repo}: ${op} blocked`;
  }
}
