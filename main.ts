import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, rmSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================================
// Types
// ============================================================================

interface Edit {
  apply(files: Map<string, FileState>): EditResult;
}

interface EditResult {
  success: boolean;
  error?: { code: string; path: string };
  changes?: FileChange[];
}

interface FileChange {
  type: 'create' | 'delete' | 'modify' | 'move';
  oldPath?: string;
  newPath: string;
  content?: string;
  lineBreak?: string;
  endsWithBreak?: boolean;
  isRename?: boolean;
}

interface FileState {
  content: string;
  lines: string[];
  lineBreak: string;
  endsWithBreak: boolean;
  exists: boolean;
}

type Tier = 0 | 1 | 2 | 3 | 4;

// ============================================================================
// Utility functions
// ============================================================================

function isSafePath(path: string): boolean {
  if (!path) return false;
  // Allow /dev/null as special marker in unified diffs
  if (path === '/dev/null') return true;
  if (path.startsWith('/') || path.includes('\\')) return false;
  const segments = path.split('/');
  for (const seg of segments) {
    if (!seg || seg === '.' || seg === '..') return false;
  }
  return true;
}

function stripPrefix(path: string): string {
  // Strip a/ or b/ prefix from unified diff paths
  if (path.startsWith('a/') || path.startsWith('b/')) {
    return path.slice(2);
  }
  return path;
}

function readFileState(path: string): FileState | null {
  try {
    const content = readFileSync(path, 'utf8');
    const firstLF = content.indexOf('\n');
    const lineBreak = firstLF > 0 && content[firstLF - 1] === '\r' ? '\r\n' : '\n';
    const lines = content.split(lineBreak);
    const endsWithBreak = content.endsWith(lineBreak);
    if (endsWithBreak) lines.pop(); // remove empty last piece
    return { content, lines, lineBreak, endsWithBreak, exists: true };
  } catch {
    return null;
  }
}

function writeFileState(path: string, state: FileState): void {
  mkdirSync(dirname(path), { recursive: true });
  const content = state.lines.join(state.lineBreak) + (state.endsWithBreak ? state.lineBreak : '');
  writeFileSync(path, content, 'utf8');
}

function deleteFileState(path: string): void {
  try { rmSync(path); } catch {}
  // Try to clean up empty parent dirs
  let d = dirname(path);
  while (d !== '.' && d !== '/') {
    try {
      const entries = readdirSync(d);
      if (entries.length > 0) break;
      rmSync(d, { recursive: true });
      d = dirname(d);
    } catch { break; }
  }
}

// ============================================================================
// Line matching tiers
// ============================================================================

function matchTier(lines: string[], target: string[], start: number, tier: Tier): number {
  if (target.length === 0) return start;
  if (start + target.length > lines.length) return -1;
  
  for (let i = start; i <= lines.length - target.length; i++) {
    let ok = true;
    for (let j = 0; j < target.length; j++) {
      if (!compareLines(lines[i + j], target[j], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return -1;
}

function compareLines(a: string, b: string, tier: Tier): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return a.replace(/\s+$/, '') === b.replace(/\s+$/, '');
  if (tier === 2) return a.trimStart() === b.trimStart();
  if (tier === 3) return a.replace(/\s+/g, ' ') === b.replace(/\s+/g, ' ');
  return false;
}

function countMatches(lines: string[], target: string[], tier: Tier): number {
  let count = 0;
  for (let i = 0; i <= lines.length - target.length; i++) {
    let ok = true;
    for (let j = 0; j < target.length; j++) {
      if (!compareLines(lines[i + j], target[j], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) count++;
  }
  return count;
}

// ============================================================================
// Unified diff parsing
// ============================================================================

function parseUnifiedDiff(text: string): Edit[] {
  const lines = text.split('\n');
  const edits: Edit[] = [];
  let i = 0;
  
  // Skip leading non-diff lines (for fenced/bare)
  while (i < lines.length && !lines[i].startsWith('--- ') && !lines[i].startsWith('diff --git ')) i++;
  if (i >= lines.length) throw new Error('parse 1');
  
  while (i < lines.length) {
    // Check for diff --git header (multi-file format)
    if (lines[i].startsWith('diff --git ')) {
      // Parse the paths from diff --git line
      // Format: diff --git a/path b/path
      const match = lines[i].match(/^diff --git a\/(.+) b\/(.+)$/);
      if (!match) throw new Error(`parse ${i + 1}`);
      i++;
      // Skip metadata lines (index, etc.) until we hit --- or +++
      while (i < lines.length && !lines[i].startsWith('--- ') && !lines[i].startsWith('+++ ')) {
        i++;
      }
      continue;
    }
    
    // Parse --- line
    if (!lines[i].startsWith('--- ')) throw new Error(`parse ${i + 1}`);
    const oldPathRaw = lines[i].slice(4).trim();
    const oldPath = stripPrefix(oldPathRaw);
    i++;
    if (i >= lines.length || !lines[i].startsWith('+++ ')) throw new Error(`parse ${i + 1}`);
    const newPathRaw = lines[i].slice(4).trim();
    const newPath = stripPrefix(newPathRaw);
    i++;
    
    // Parse hunks
    const hunks: { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[]; noNewlineAtEnd?: boolean }[] = [];
    while (i < lines.length && lines[i].startsWith('@@ ')) {
      const hunkLine = lines[i];
      i++;
      const match = hunkLine.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (!match) throw new Error(`parse ${i}`);
      const oldStart = parseInt(match[1], 10) - 1;
      const oldLines = match[2] ? parseInt(match[2], 10) : 1;
      const newStart = parseInt(match[3], 10) - 1;
      const newLines = match[4] ? parseInt(match[4], 10) : 1;
      
      const hunkLines: string[] = [];
      let noNewlineAtEnd = false;
      while (i < lines.length && !lines[i].startsWith('--- ') && !lines[i].startsWith('+++ ') && !lines[i].startsWith('@@ ') && !lines[i].startsWith('diff --git ')) {
        if (lines[i] === '\\ No newline at end of file') {
          noNewlineAtEnd = true;
          i++;
          continue;
        }
        // Hunk lines must start with ' ', '-', '+', or be empty
        if (!lines[i].startsWith(' ') && !lines[i].startsWith('-') && !lines[i].startsWith('+') && lines[i] !== '') {
          break;
        }
        hunkLines.push(lines[i]);
        i++;
      }
      hunks.push({ oldStart, oldLines, newStart, newLines, lines: hunkLines, noNewlineAtEnd });
    }
    
    if (hunks.length === 0) throw new Error(`parse ${i}`);
    
    edits.push(new UnifiedDiffEdit(oldPath, newPath, hunks));
    
    // Skip trailing non-diff lines (for fenced/bare)
    while (i < lines.length && !lines[i].startsWith('--- ') && !lines[i].startsWith('diff --git ')) i++;
  }
  
  return edits;
}

class UnifiedDiffEdit {
  oldPath: string;
  newPath: string;
  hunks: { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[]; noNewlineAtEnd?: boolean }[];
  
  constructor(oldPath: string, newPath: string, hunks: { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[]; noNewlineAtEnd?: boolean }[]) {
    this.oldPath = oldPath;
    this.newPath = newPath;
    this.hunks = hunks;
  }
  
  apply(files: Map<string, FileState>): EditResult {
    const path = this.oldPath === '/dev/null' || this.oldPath === '' ? this.newPath : this.oldPath;
    if (!isSafePath(path)) return { success: false, error: { code: 'unsafe', path } };
    
    // Check if file exists
    let file = files.get(path);
    if (!file) {
      file = readFileState(join(process.cwd(), path));
      if (file) files.set(path, file);
    }
    
    const isCreate = this.oldPath === '/dev/null' || this.oldPath === '';
    if (isCreate) {
      // Creating new file - must not exist
      if (existsSync(join(process.cwd(), path)) || (file && file.exists)) {
        return { success: false, error: { code: 'exists', path } };
      }
      // Create new file from hunks
      const newLines: string[] = [];
      
      for (const hunk of this.hunks) {
        for (const line of hunk.lines) {
          if (line.startsWith('+')) newLines.push(line.slice(1));
          else if (line.startsWith(' ')) newLines.push(line.slice(1));
        }
      }
      
      // Determine line break from first hunk or default to LF
      const lineBreak = file?.lineBreak || '\n';
      const endsWithBreak = !(this.hunks.some(h => h.noNewlineAtEnd));
      
      files.set(path, { content: '', lines: newLines, lineBreak, endsWithBreak, exists: true });
      return { success: true, changes: [{ type: 'create', newPath: path, content: newLines.join(lineBreak) + (endsWithBreak ? lineBreak : ''), lineBreak, endsWithBreak }] };
    } else {
      // Modifying existing file - must exist
      if (!file || !file.exists) {
        return { success: false, error: { code: 'missing', path } };
      }
    }
    
    // Apply hunks to existing file
    const tiers: Tier[] = [0, 1, 2, 3];
    const newLines = [...file.lines];
    let cursor = 0;
    
    for (const hunk of this.hunks) {
      // Find the hunk location using context lines
      const oldContext: string[] = [];
      const newContext: string[] = [];
      
      for (const line of hunk.lines) {
        if (line.startsWith(' ') || line.startsWith('-') || line === '') oldContext.push(line === '' ? '' : line.slice(1));
        if (line.startsWith(' ') || line.startsWith('+') || line === '') newContext.push(line === '' ? '' : line.slice(1));
      }
      
      // Trim trailing empty lines from context (they don't help matching)
      while (oldContext.length > 0 && oldContext[oldContext.length - 1] === '') oldContext.pop();
      while (newContext.length > 0 && newContext[newContext.length - 1] === '') newContext.pop();
      
      // Try to find match at each tier
      let matchIdx = -1;
      let matchedTier: Tier = 0;
      
      // If oldContext is empty, it's an insertion - use newStart from hunk header
      if (oldContext.length === 0) {
        matchIdx = hunk.newStart;
        if (matchIdx < 0) matchIdx = 0;
        if (matchIdx > newLines.length) matchIdx = newLines.length;
        matchedTier = 0;
      } else {
        // Search from max(cursor, oldStart - context) to handle non-adjacent hunks
        const searchStart = Math.max(cursor, Math.max(0, hunk.oldStart - 50));
        for (const tier of tiers) {
          const idx = matchTier(newLines, oldContext, searchStart, tier);
          if (idx >= 0) {
            // Check uniqueness at this tier
            const count = countMatches(newLines, oldContext, tier);
            if (count === 1) {
              matchIdx = idx;
              matchedTier = tier;
              break;
            }
          }
        }
      }
      
      if (matchIdx < 0) {
        // Check if ambiguous at any tier
        for (const tier of tiers) {
          if (countMatches(newLines, oldContext, tier) > 1) {
            return { success: false, error: { code: 'ambiguous', path } };
          }
        }
        return { success: false, error: { code: 'no-match', path } };
      }
      
      // Replace oldContext with newContext
      newLines.splice(matchIdx, oldContext.length, ...newContext);
      cursor = matchIdx + newContext.length;
    }
    
    // Check if file actually changed
    const newContent = newLines.join(file.lineBreak) + (file.endsWithBreak ? file.lineBreak : '');
    if (newContent === file.content) {
      return { success: true, changes: [] };
    }
    
    // Handle move
    if (this.newPath !== this.oldPath && this.oldPath !== '/dev/null' && this.oldPath !== '') {
      if (!isSafePath(this.newPath)) return { success: false, error: { code: 'unsafe', path: this.newPath } };
      if (existsSync(join(process.cwd(), this.newPath))) {
        return { success: false, error: { code: 'exists', path: this.newPath } };
      }
      // Check if any hunk has noNewlineAtEnd to preserve that
      const endsWithBreak = !(this.hunks.some(h => h.noNewlineAtEnd));
      files.set(this.newPath, { ...file, lines: newLines, content: newContent, exists: true, endsWithBreak });
      files.delete(path);
      return { 
        success: true, 
        changes: [
          { type: 'delete', newPath: path },
          { type: 'create', newPath: this.newPath, content: newContent, lineBreak: file.lineBreak, endsWithBreak }
        ]
      };
    }
    
    // Check if any hunk has noNewlineAtEnd to preserve that
    const endsWithBreak = !(this.hunks.some(h => h.noNewlineAtEnd));
    file.lines = newLines;
    file.content = newContent;
    file.endsWithBreak = endsWithBreak;
    return { success: true, changes: [{ type: 'modify', newPath: path, content: newContent, lineBreak: file.lineBreak, endsWithBreak }] };
  }
}

// ============================================================================
// SEARCH/REPLACE parsing
// ============================================================================

function parseSearchReplace(text: string): Edit[] {
  const lines = text.split('\n');
  const edits: Edit[] = [];
  let i = 0;
  
  while (i < lines.length) {
    // Find ```x or ```
    if (!lines[i].startsWith('```')) { i++; continue; }
    const fence = lines[i];
    const lang = fence.slice(3).trim();
    i++;
    
    if (i >= lines.length || !lines[i].startsWith('<<<<<<< SEARCH')) throw new Error(`parse ${i + 1}`);
    i++;
    
    const oldLines: string[] = [];
    while (i < lines.length && !lines[i].startsWith('=======')) {
      oldLines.push(lines[i]);
      i++;
    }
    if (i >= lines.length) throw new Error(`parse ${i + 1}`);
    i++; // skip =======
    
    const newLines: string[] = []
    while (i < lines.length && !lines[i].startsWith('>>>>>>> REPLACE')) {
      newLines.push(lines[i]);
      i++;
    }
    if (i >= lines.length) throw new Error(`parse ${i + 1}`);
    i++; // skip >>>>>>> REPLACE
    
    if (i >= lines.length || !lines[i].startsWith('```')) throw new Error(`parse ${i + 1}`);
    i++;
    
    // Extract path from first line of oldLines if it looks like a path
    let path = '';
    if (oldLines.length > 0 && oldLines[0].includes('/') && !oldLines[0].includes(' ') && !oldLines[0].startsWith('\t')) {
      path = oldLines[0];
      oldLines.shift();
    } else {
      throw new Error(`parse ${i - oldLines.length - newLines.length - 4}`);
    }
    
    edits.push(new SearchReplaceEdit(path, oldLines, newLines));
  }
  
  if (edits.length === 0) throw new Error('parse 1');
  return edits;
}

class SearchReplaceEdit {
  path: string;
  oldLines: string[];
  newLines: string[];
  
  constructor(path: string, oldLines: string[], newLines: string[]) {
    this.path = path;
    this.oldLines = oldLines;
    this.newLines = newLines;
  }
  
  apply(files: Map<string, FileState>): EditResult {
    if (!isSafePath(this.path)) return { success: false, error: { code: 'unsafe', path: this.path } };
    
    let file = files.get(this.path);
    if (!file) {
      file = readFileState(join(process.cwd(), this.path));
      if (file) files.set(this.path, file);
    }
    
    if (!file || !file.exists) {
      return { success: false, error: { code: 'missing', path: this.path } };
    }
    
    const tiers: Tier[] = [0, 1, 2, 3];
    let matchIdx = -1;
    
    for (const tier of tiers) {
      const count = countMatches(file.lines, this.oldLines, tier);
      if (count === 1) {
        matchIdx = matchTier(file.lines, this.oldLines, 0, tier);
        break;
      } else if (count > 1) {
        return { success: false, error: { code: 'ambiguous', path: this.path } };
      }
    }
    
    if (matchIdx < 0) {
      return { success: false, error: { code: 'no-match', path: this.path } };
    }
    
    const newFileLines = [...file.lines];
    newFileLines.splice(matchIdx, this.oldLines.length, ...this.newLines);
    const newContent = newFileLines.join(file.lineBreak) + (file.endsWithBreak ? file.lineBreak : '');
    
    if (newContent === file.content) {
      return { success: true, changes: [] };
    }
    
    file.lines = newFileLines;
    file.content = newContent;
    return { success: true, changes: [{ type: 'modify', newPath: this.path, content: newContent, lineBreak: file.lineBreak, endsWithBreak: file.endsWithBreak }] };
  }
}

// ============================================================================
// V4A parsing
// ============================================================================

function parseV4A(text: string): Edit[] {
  const lines = text.split('\n');
  let i = 0;
  
  // Find first non-blank line
  while (i < lines.length && lines[i].trim() === '') i++;
  if (i >= lines.length || lines[i].trim() !== '*** Begin Patch') throw new Error(`parse ${i + 1}`);
  i++;
  
  const edits: Edit[] = [];
  
  while (i < lines.length) {
    // Skip blank lines
    while (i < lines.length && lines[i].trim() === '') i++;
    if (i >= lines.length) break;
    
    const line = lines[i];
    if (line.trim() === '*** End Patch') {
      i++;
      break;
    }
    
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice(13).trim();
      i++;
      const fileLines: string[] = [];
      while (i < lines.length) {
        if (lines[i].startsWith('*** ')) break;
        if (lines[i] === '') { fileLines.push(''); i++; continue; }
        if (!lines[i].startsWith('+')) throw new Error(`parse ${i + 1}`);
        fileLines.push(lines[i].slice(1));
        i++;
      }
      edits.push(new V4AAddEdit(path, fileLines));
    } else if (line.startsWith('*** Delete File: ')) {
      const path = line.slice(16).trim();
      i++;
      // Skip blank lines until next section
      while (i < lines.length && lines[i].trim() === '') i++;
      edits.push(new V4ADeleteEdit(path));
    } else if (line.startsWith('*** Update File: ')) {
      const path = line.slice(16).trim();
      i++;
      
      let moveTo: string | null = null;
      if (i < lines.length && lines[i].startsWith('*** Move to: ')) {
        moveTo = lines[i].slice(12).trim();
        i++;
      }
      
      const chunks: V4AChunk[] = [];
      while (i < lines.length) {
        if (lines[i].startsWith('*** ')) break;
        if (lines[i].trim() === '') { i++; continue; }
        
        let anchor = '';
        if (lines[i].startsWith('@@')) {
          anchor = lines[i].slice(2).trim();
          i++;
        }
        
        const bodyLines: string[] = [];
        let endOfFile = false;
        while (i < lines.length) {
          if (lines[i] === '*** End of File') {
            endOfFile = true;
            i++;
            break;
          }
          if (lines[i].startsWith('*** ') || lines[i].startsWith('@@')) break;
          bodyLines.push(lines[i]);
          i++;
        }
        
        if (bodyLines.length === 0 && !endOfFile && anchor === '') {
          // First chunk can start without @@
        }
        
        chunks.push({ anchor, bodyLines, endOfFile });
      }
      
      edits.push(new V4AUpdateEdit(path, moveTo, chunks));
    } else {
      throw new Error(`parse ${i + 1}`);
    }
  }
  
  if (edits.length === 0) throw new Error('parse 1');
  return edits;
}

interface V4AChunk {
  anchor: string;
  bodyLines: string[];
  endOfFile: boolean;
}

class V4AAddEdit {
  path: string;
  fileLines: string[];
  
  constructor(path: string, fileLines: string[]) {
    this.path = path;
    this.fileLines = fileLines;
  }
  
  apply(files: Map<string, FileState>): EditResult {
    if (!isSafePath(this.path)) return { success: false, error: { code: 'unsafe', path: this.path } };
    
    if (existsSync(join(process.cwd(), this.path))) {
      return { success: false, error: { code: 'exists', path: this.path } };
    }
    
    const content = this.fileLines.join('\n') + '\n';
    files.set(this.path, { content, lines: this.fileLines, lineBreak: '\n', endsWithBreak: true, exists: true });
    return { success: true, changes: [{ type: 'create', newPath: this.path, content, lineBreak: '\n', endsWithBreak: true }] };
  }
}

class V4ADeleteEdit {
  path: string;
  
  constructor(path: string) {
    this.path = path;
  }
  
  apply(files: Map<string, FileState>): EditResult {
    if (!isSafePath(this.path)) return { success: false, error: { code: 'unsafe', path: this.path } };
    
    let file = files.get(this.path);
    if (!file) {
      file = readFileState(join(process.cwd(), this.path));
      if (file) files.set(this.path, file);
    }
    
    if (!file || !file.exists) {
      return { success: false, error: { code: 'missing', path: this.path } };
    }
    
    files.delete(this.path);
    return { success: true, changes: [{ type: 'delete', newPath: this.path }] };
  }
}

class V4AUpdateEdit {
  path: string;
  moveTo: string | null;
  chunks: V4AChunk[];
  
  constructor(path: string, moveTo: string | null, chunks: V4AChunk[]) {
    this.path = path;
    this.moveTo = moveTo;
    this.chunks = chunks;
  }
  
  apply(files: Map<string, FileState>): EditResult {
    if (!isSafePath(this.path)) return { success: false, error: { code: 'unsafe', path: this.path } };
    
    let file = files.get(this.path);
    if (!file) {
      file = readFileState(join(process.cwd(), this.path));
      if (file) files.set(this.path, file);
    }
    
    if (!file || !file.exists) {
      return { success: false, error: { code: 'missing', path: this.path } };
    }
    
    if (this.moveTo !== null) {
      if (!isSafePath(this.moveTo)) return { success: false, error: { code: 'unsafe', path: this.moveTo } };
      if (existsSync(join(process.cwd(), this.moveTo))) {
        return { success: false, error: { code: 'exists', path: this.moveTo } };
      }
    }
    
    const tiers: Tier[] = [0, 1, 2, 3];
    const newLines = [...file.lines];
    let cursor = 0;
    
    for (const chunk of this.chunks) {
      // Handle anchor
      if (chunk.anchor !== '') {
        let found = false;
        for (const tier of tiers) {
          const idx = matchTier(newLines, [chunk.anchor], cursor, tier);
          if (idx >= 0) {
            // Check uniqueness
            const count = countMatches(newLines, [chunk.anchor], tier);
            if (count === 1) {
              cursor = idx + 1;
              found = true;
              break;
            }
          }
        }
        if (!found) {
          // Check if ambiguous
          for (const tier of tiers) {
            if (countMatches(newLines, [chunk.anchor], tier) > 1) {
              return { success: false, error: { code: 'ambiguous', path: this.path } };
            }
          }
          return { success: false, error: { code: 'no-match', path: this.path } };
        }
      }
      
      // Extract old and new lines from chunk
      const oldContext: string[] = [];
      const newContext: string[] = [];
      
      for (const line of chunk.bodyLines) {
        if (line.startsWith(' ') || line.startsWith('-')) oldContext.push(line.slice(1));
        if (line.startsWith(' ') || line.startsWith('+')) newContext.push(line.slice(1));
      }
      
      if (oldContext.length === 0) {
        // Insert at cursor
        newLines.splice(cursor, 0, ...newContext);
        cursor += newContext.length;
        continue;
      }
      
      // Find match
      let matchIdx = -1;
      let matchedTier: Tier = 0;
      
      if (chunk.endOfFile) {
        // Must match at end of file
        for (const tier of tiers) {
          const idx = matchTier(newLines, oldContext, cursor, tier);
          if (idx >= 0 && idx + oldContext.length === newLines.length) {
            // Check uniqueness
            const count = countMatches(newLines, oldContext, tier);
            if (count === 1) {
              matchIdx = idx;
              matchedTier = tier;
              break;
            }
          }
        }
      } else {
        for (const tier of tiers) {
          const idx = matchTier(newLines, oldContext, cursor, tier);
          if (idx >= 0) {
            // Check uniqueness
            const count = countMatches(newLines, oldContext, tier);
            if (count === 1) {
              matchIdx = idx;
              matchedTier = tier;
              break;
            }
          }
        }
      }
      
      if (matchIdx < 0) {
        // Check if ambiguous
        for (const tier of tiers) {
          if (countMatches(newLines, oldContext, tier) > 1) {
            return { success: false, error: { code: 'ambiguous', path: this.path } };
          }
        }
        return { success: false, error: { code: 'no-match', path: this.path } };
      }
      
      // Replace oldContext with newContext
      newLines.splice(matchIdx, oldContext.length, ...newContext);
      cursor = matchIdx + newContext.length;
    }
    
    const newContent = newLines.join(file.lineBreak) + (file.endsWithBreak ? file.lineBreak : '');
    if (newContent === file.content) {
      return { success: true, changes: [] };
    }
    
    if (this.moveTo !== null) {
      files.set(this.moveTo, { ...file, lines: newLines, content: newContent, exists: true });
      files.delete(this.path);
      return { 
        success: true, 
        changes: [
          { type: 'delete', newPath: this.path },
          { type: 'create', newPath: this.moveTo, content: newContent, lineBreak: file.lineBreak, endsWithBreak: file.endsWithBreak }
        ]
      };
    }
    
    file.lines = newLines;
    file.content = newContent;
    return { success: true, changes: [{ type: 'modify', newPath: this.path, content: newContent, lineBreak: file.lineBreak, endsWithBreak: file.endsWithBreak }] };
  }
}

// ============================================================================
// JSON parsing
// ============================================================================

function parseJsonEdits(text: string): Edit[] {
  const lines = text.split('\n');
  const edits: Edit[] = [];
  
  // Try JSON array first
  try {
    const arr = JSON.parse(text);
    if (Array.isArray(arr)) {
      for (const obj of arr) {
        edits.push(parseJsonEdit(obj));
      }
      if (edits.length === 0) throw new Error('parse 1');
      return edits;
    }
  } catch {}
  
  // Try JSON Lines
  let lineNum = 0;
  for (const line of lines) {
    lineNum++;
    if (line.trim() === '') continue;
    try {
      const obj = JSON.parse(line);
      edits.push(parseJsonEdit(obj));
    } catch {
      throw new Error(`parse ${lineNum}`);
    }
  }
  
  if (edits.length === 0) throw new Error('parse 1');
  return edits;
}

function parseJsonEdit(obj: any): Edit {
  if (!obj || typeof obj !== 'object' || !obj.path || !obj.command) {
    throw new Error('parse 1');
  }
  
  const path = obj.path;
  const command = obj.command;
  
  if (command === 'create') {
    if (typeof obj.file_text !== 'string') throw new Error('parse 1');
    return new JsonCreateEdit(path, obj.file_text);
  } else if (command === 'str_replace') {
    if (typeof obj.old_str !== 'string' || obj.old_str === '') throw new Error('parse 1');
    const newStr = obj.new_str ?? '';
    return new JsonStrReplaceEdit(path, obj.old_str, newStr);
  } else if (command === 'insert') {
    if (typeof obj.insert_line !== 'number' || obj.insert_line < 0) throw new Error('parse 1');
    const newStr = obj.new_str ?? '';
    return new JsonInsertEdit(path, obj.insert_line, newStr);
  } else {
    throw new Error('parse 1');
  }
}

class JsonCreateEdit {
  path: string;
  fileText: string;
  
  constructor(path: string, fileText: string) {
    this.path = path;
    this.fileText = fileText;
  }
  
  apply(files: Map<string, FileState>): EditResult {
    if (!isSafePath(this.path)) return { success: false, error: { code: 'unsafe', path: this.path } };
    
    if (existsSync(join(process.cwd(), this.path))) {
      return { success: false, error: { code: 'exists', path: this.path } };
    }
    
    // Detect line break from file_text
    const firstLF = this.fileText.indexOf('\n');
    const lineBreak = firstLF > 0 && this.fileText[firstLF - 1] === '\r' ? '\r\n' : '\n';
    const lines = this.fileText.split(lineBreak);
    const endsWithBreak = this.fileText.endsWith(lineBreak);
    if (endsWithBreak) lines.pop();
    
    files.set(this.path, { content: this.fileText, lines, lineBreak, endsWithBreak, exists: true });
    return { success: true, changes: [{ type: 'create', newPath: this.path, content: this.fileText, lineBreak, endsWithBreak }] };
  }
}

class JsonStrReplaceEdit {
  path: string;
  oldStr: string;
  newStr: string;
  
  constructor(path: string, oldStr: string, newStr: string) {
    this.path = path;
    this.oldStr = oldStr;
    this.newStr = newStr;
  }
  
  apply(files: Map<string, FileState>): EditResult {
    if (!isSafePath(this.path)) return { success: false, error: { code: 'unsafe', path: this.path } };
    
    let file = files.get(this.path);
    if (!file) {
      file = readFileState(join(process.cwd(), this.path));
      if (file) files.set(this.path, file);
    }
    
    if (!file || !file.exists) {
      return { success: false, error: { code: 'missing', path: this.path } };
    }
    
    // In CRLF file, read with \r\n as \n
    let fileText = file.content;
    let oldStr = this.oldStr;
    let newStr = this.newStr;
    
    if (file.lineBreak === '\r\n') {
      fileText = fileText.replace(/\r\n/g, '\n');
      oldStr = oldStr.replace(/\r\n/g, '\n');
      newStr = newStr.replace(/\r\n/g, '\n');
    }
    
    // Count occurrences (positions may overlap)
    let count = 0;
    let pos = fileText.indexOf(oldStr);
    while (pos >= 0) {
      count++;
      pos = fileText.indexOf(oldStr, pos + 1);
    }
    
    if (count === 0) {
      return { success: false, error: { code: 'no-match', path: this.path } };
    }
    if (count > 1) {
      return { success: false, error: { code: 'ambiguous', path: this.path } };
    }
    
    const idx = fileText.indexOf(oldStr);
    const newFileText = fileText.slice(0, idx) + newStr + fileText.slice(idx + oldStr.length);
    
    // Write back with original line break
    if (file.lineBreak === '\r\n') {
      const finalText = newFileText.replace(/\n/g, '\r\n');
      const lines = finalText.split('\r\n');
      const endsWithBreak = finalText.endsWith('\r\n');
      if (endsWithBreak) lines.pop();
      file.content = finalText;
      file.lines = lines;
      file.endsWithBreak = endsWithBreak;
    } else {
      const lines = newFileText.split('\n');
      const endsWithBreak = newFileText.endsWith('\n');
      if (endsWithBreak) lines.pop();
      file.content = newFileText;
      file.lines = lines;
      file.endsWithBreak = endsWithBreak;
    }
    
    return { success: true, changes: [{ type: 'modify', newPath: this.path, content: file.content, lineBreak: file.lineBreak, endsWithBreak: file.endsWithBreak }] };
  }
}

class JsonInsertEdit {
  path: string;
  insertLine: number;
  newStr: string;
  
  constructor(path: string, insertLine: number, newStr: string) {
    this.path = path;
    this.insertLine = insertLine;
    this.newStr = newStr;
  }
  
  apply(files: Map<string, FileState>): EditResult {
    if (!isSafePath(this.path)) return { success: false, error: { code: 'unsafe', path: this.path } };
    
    let file = files.get(this.path);
    if (!file) {
      file = readFileState(join(process.cwd(), this.path));
      if (file) files.set(this.path, file);
    }
    
    if (!file || !file.exists) {
      return { success: false, error: { code: 'missing', path: this.path } };
    }
    
    if (this.insertLine < 0 || this.insertLine > file.lines.length) {
      return { success: false, error: { code: 'no-match', path: this.path } };
    }
    
    // Split new_str into lines (split at \n, each with one trailing \r removed, without the empty piece after a final \n)
    let newLines = this.newStr.split('\n').map(l => l.endsWith('\r') ? l.slice(0, -1) : l);
    // Remove empty piece after final \n
    if (this.newStr.endsWith('\n') && newLines.length > 0 && newLines[newLines.length - 1] === '') {
      newLines.pop();
    }
    
    const newFileLines = [...file.lines];
    newFileLines.splice(this.insertLine, 0, ...newLines);
    
    const newContent = newFileLines.join(file.lineBreak) + (file.endsWithBreak ? file.lineBreak : '');
    
    if (newContent === file.content) {
      return { success: true, changes: [] };
    }
    
    file.lines = newFileLines;
    file.content = newContent;
    return { success: true, changes: [{ type: 'modify', newPath: this.path, content: newContent, lineBreak: file.lineBreak, endsWithBreak: file.endsWithBreak }] };
  }
}

// ============================================================================
// Format detection
// ============================================================================

function detectFormat(text: string): string {
  // Check for V4A
  const lines = text.split('\n');
  for (const line of lines) {
    if (line.trim() === '*** Begin Patch') return 'v4a';
  }
  
  // Check for JSON
  const trimmed = text.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) return 'json';
  
  // Check for search-replace (fenced)
  if (text.includes('```') && text.includes('<<<<<<< SEARCH')) return 'search-replace';
  
  // Check for unified diff - need both --- and +++ or valid diff --git with following --- +++
  let hasDiffGit = false;
  let hasOld = false;
  let hasNew = false;
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      hasDiffGit = true;
    } else if (line.startsWith('--- ')) {
      hasOld = true;
    } else if (line.startsWith('+++ ')) {
      hasNew = true;
    }
  }
  if (hasDiffGit && hasOld && hasNew) return 'unified';
  if (!hasDiffGit && hasOld && hasNew) return 'unified';
  
  return 'none';
}

// ============================================================================
// Argument parsing
// ============================================================================

interface ParsedArgs {
  format: string;
  check: boolean;
  strict: boolean;
  patchFile: string | null;
}

function parseArgs(args: string[]): ParsedArgs {
  const result: ParsedArgs = {
    format: 'auto',
    check: false,
    strict: false,
    patchFile: null
  };
  
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === '--') {
      i++;
      break;
    }
    if (arg === '--check') {
      if (result.check) throw new Error('usage');
      result.check = true;
    } else if (arg === '--strict') {
      if (result.strict) throw new Error('usage');
      result.strict = true;
    } else if (arg.startsWith('--format=')) {
      if (result.format !== 'auto') throw new Error('usage');
      const val = arg.slice(9);
      if (!['auto', 'unified', 'search-replace', 'v4a', 'json'].includes(val)) throw new Error('usage');
      result.format = val;
    } else if (arg === '--format') {
      if (result.format !== 'auto') throw new Error('usage');
      i++;
      if (i >= args.length) throw new Error('usage');
      const val = args[i];
      if (!['auto', 'unified', 'search-replace', 'v4a', 'json'].includes(val)) throw new Error('usage');
      result.format = val;
    } else if (arg.startsWith('-') && arg !== '-') {
      throw new Error('usage');
    } else {
      if (result.patchFile !== null) throw new Error('usage');
      result.patchFile = arg;
    }
    i++;
  }
  
  // Handle remaining args after --
  while (i < args.length) {
    if (result.patchFile !== null) throw new Error('usage');
    result.patchFile = args[i];
    i++;
  }
  
  return result;
}

async function main() {
  let format: string;
  let check: boolean;
  let strict: boolean;
  let patchFile: string | null;
  
  try {
    const parsed = parseArgs(process.argv.slice(2));
    format = parsed.format;
    check = parsed.check;
    strict = parsed.strict;
    patchFile = parsed.patchFile;
  } catch (e) {
    console.log('error: usage');
    process.exit(2);
  }
  
  // Read patch
  let patchText: string;
  try {
    if (patchFile === null || patchFile === '-') {
      patchText = readFileSync(0, 'utf8');
    } else {
      patchText = readFileSync(patchFile, 'utf8');
    }
  } catch {
    console.log('error: no-patch');
    process.exit(2);
  }
  
  // Detect format
  if (format === 'auto') {
    format = detectFormat(patchText);
    if (format === 'none') {
      console.log('error: format');
      process.exit(2);
    }
  }
  
  // Parse patch
  let edits: Edit[];
  try {
    switch (format) {
      case 'unified': edits = parseUnifiedDiff(patchText); break;
      case 'search-replace': edits = parseSearchReplace(patchText); break;
      case 'v4a': edits = parseV4A(patchText); break;
      case 'json': edits = parseJsonEdits(patchText); break;
      default: console.log('error: format'); process.exit(2);
    }
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.startsWith('parse ')) {
      console.log(`error: ${msg}`);
      process.exit(2);
    }
    throw e;
  }
  
  // Apply edits
  const files = new Map<string, FileState>();
  const errors: { code: string; path: string }[] = [];
  const allChanges: FileChange[] = [];
  
  // For strict mode, we only use tier 0
  // We'll need to pass this to the edits
  
  for (const edit of edits) {
    const result = edit.apply(files);
    if (!result.success && result.error) {
      errors.push(result.error);
    }
    if (result.changes) {
      allChanges.push(...result.changes);
    }
  }
  
  if (errors.length > 0) {
    for (const err of errors) {
      console.log(`error: ${err.code} ${err.path}`);
    }
    console.log(`failed: ${errors.length} of ${edits.length} edits`);
    process.exit(1);
  }
  
  // Collect paths that actually changed
  const changedPaths = new Set<string>();
  const moveMap = new Map<string, string>(); // newPath -> oldPath
  
  for (const change of allChanges) {
    if (change.type === 'create' || change.type === 'modify') {
      changedPaths.add(change.newPath);
    } else if (change.type === 'delete') {
      changedPaths.add(change.newPath);
    } else if (change.type === 'move') {
      changedPaths.add(change.newPath);
      moveMap.set(change.newPath, change.oldPath!);
    }
  }
  
  // Sort paths by byte order (UTF-8)
  const sortedPaths = Array.from(changedPaths).sort();
  
  const outputLines: string[] = [];
  const processedMoves = new Set<string>();
  
  for (const path of sortedPaths) {
    if (moveMap.has(path) && !processedMoves.has(path)) {
      const oldPath = moveMap.get(path)!;
      outputLines.push(`R ${oldPath} -> ${path}`);
      processedMoves.add(path);
      // Don't output D and A for moved files
      continue;
    }
    
    // Check if this path was deleted as part of a move
    let isMoveDelete = false;
    for (const [newP, oldP] of moveMap) {
      if (oldP === path) {
        isMoveDelete = true;
        break;
      }
    }
    if (isMoveDelete) continue;
    
    // Find the change for this path
    const change = allChanges.find(c => c.newPath === path);
    if (change) {
      if (change.type === 'create') outputLines.push(`A ${change.newPath}`);
      else if (change.type === 'delete') outputLines.push(`D ${change.newPath}`);
      else if (change.type === 'modify') outputLines.push(`M ${change.newPath}`);
    }
  }
  
  if (!check) {
    // Actually write files
    for (const [path, state] of files) {
      if (state.exists) {
        writeFileState(join(process.cwd(), path), state);
      } else {
        deleteFileState(join(process.cwd(), path));
      }
    }
  }
  
  outputLines.push(`ok: ${sortedPaths.length} file${sortedPaths.length !== 1 ? 's' : ''}`);
  console.log(outputLines.join('\n'));
  process.exit(0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
