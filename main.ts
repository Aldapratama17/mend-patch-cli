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
  if (!path || path.startsWith('/') || path.includes('\\')) return false;
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
  if (tier === 1) return a.trim() === b.trim();
  if (tier === 2) return a.trimStart() === b.trimStart();
  if (tier === 3) return a.replace(/^\s*/, '') === b.replace(/^\s*/, '');
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
  while (i < lines.length && !lines[i].startsWith('--- ')) i++;
  if (i >= lines.length) throw new Error('parse 1');
  
  while (i < lines.length) {
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
    const hunks: { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }[] = [];
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
      while (i < lines.length && !lines[i].startsWith('--- ') && !lines[i].startsWith('+++ ') && !lines[i].startsWith('@@ ')) {
        hunkLines.push(lines[i]);
        i++;
      }
      hunks.push({ oldStart, oldLines, newStart, newLines, lines: hunkLines });
    }
    
    if (hunks.length === 0) throw new Error(`parse ${i}`);
    
    edits.push(new UnifiedDiffEdit(oldPath, newPath, hunks));
  }
  
  return edits;
}

class UnifiedDiffEdit {
  oldPath: string;
  newPath: string;
  hunks: { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }[];
  
  constructor(oldPath: string, newPath: string, hunks: { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }[]) {
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
    
    const isCreate = !file || !file.exists;
    if (isCreate) {
      if (existsSync(join(process.cwd(), path))) {
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
      
      files.set(path, { content: '', lines: newLines, lineBreak: '\n', endsWithBreak: true, exists: true });
      return { success: true, changes: [{ type: 'create', newPath: path, content: newLines.join('\n') + '\n', lineBreak: '\n', endsWithBreak: true }] };
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
        if (line.startsWith(' ') || line.startsWith('-')) oldContext.push(line.slice(1));
        if (line.startsWith(' ') || line.startsWith('+')) newContext.push(line.slice(1));
      }
      
      // Try to find match at each tier
      let matchIdx = -1;
      let matchedTier: Tier = 0;
      
      for (const tier of tiers) {
        const idx = matchTier(newLines, oldContext, cursor, tier);
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
      files.set(this.newPath, { ...file, lines: newLines, content: newContent, exists: true });
      files.delete(path);
      return { 
        success: true, 
        changes: [
          { type: 'delete', newPath: path },
          { type: 'create', newPath: this.newPath, content: newContent, lineBreak: file.lineBreak, endsWithBreak: file.endsWithBreak }
        ]
      };
    }
    
    file.lines = newLines;
    file.content = newContent;
    return { success: true, changes: [{ type: 'modify', newPath: path, content: newContent, lineBreak: file.lineBreak, endsWithBreak: file.endsWithBreak }] };
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
    
    const newLines: string[] = [];
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
        
        if (endOfFile) {
          // Skip blank lines after End of File
          while (i < lines.length && lines[i].trim() === '') i++;
          break;
        }
      }
      
      if (chunks.length === 0 && !moveTo) throw new Error(`parse ${i - chunks.length}`);
      edits.push(new V4AUpdateEdit(path, moveTo, chunks));
    } else {
      throw new Error(`parse ${i + 1}`);
    }
  }
  
  // Verify End Patch
  while (i < lines.length && lines[i].trim() === '') i++;
  if (i >= lines.length || lines[i].trim() !== '*** End Patch') {
    throw new Error(`parse ${lines.length + 1}`);
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
    
    if (this.moveTo) {
      if (!isSafePath(this.moveTo)) return { success: false, error: { code: 'unsafe', path: this.moveTo } };
      if (existsSync(join(process.cwd(), this.moveTo))) {
        return { success: false, error: { code: 'exists', path: this.moveTo } };
      }
    }
    
    const tiers: Tier[] = [0, 1, 2, 3];
    let cursor = 0;
    const newLines = [...file.lines];
    
    for (const chunk of this.chunks) {
      // Parse O (old) and N (new) from bodyLines
      const oldLines: string[] = [];
      const newLinesChunk: string[] = [];
      
      for (const line of chunk.bodyLines) {
        if (line.startsWith(' ') || line.startsWith('-')) oldLines.push(line.slice(1));
        if (line.startsWith(' ') || line.startsWith('+')) newLinesChunk.push(line.slice(1));
      }
      
      if (chunk.anchor) {
        // Find anchor line
        let anchorIdx = -1;
        for (const tier of tiers) {
          for (let j = cursor; j < newLines.length; j++) {
            if (compareLines(newLines[j], chunk.anchor, tier)) {
              anchorIdx = j;
              break;
            }
          }
          if (anchorIdx >= 0) break;
        }
        if (anchorIdx < 0) {
          return { success: false, error: { code: 'no-match', path: this.path } };
        }
        cursor = anchorIdx + 1;
      }
      
      if (oldLines.length === 0) {
        // Insert at cursor
        newLines.splice(cursor, 0, ...newLinesChunk);
        cursor += newLinesChunk.length;
      } else {
        // Find oldLines at or after cursor
        let matchIdx = -1;
        let matchedTier: Tier = 0;
        
        for (const tier of tiers) {
          const idx = matchTier(newLines, oldLines, cursor, tier);
          if (idx >= 0) {
            const count = countMatches(newLines.slice(cursor), oldLines, tier);
            if (count === 1) {
              matchIdx = idx;
              matchedTier = tier;
              break;
            }
          }
        }
        
        if (matchIdx < 0) {
          for (const tier of tiers) {
            if (countMatches(newLines.slice(cursor), oldLines, tier) > 1) {
              return { success: false, error: { code: 'ambiguous', path: this.path } };
            }
          }
          
          if (chunk.endOfFile) {
            // Check if oldLines matches at end of file
            if (newLines.length >= oldLines.length) {
              const tailStart = newLines.length - oldLines.length;
              let ok = true;
              for (let j = 0; j < oldLines.length; j++) {
                if (!compareLines(newLines[tailStart + j], oldLines[j], 0)) {
                  ok = false; break;
                }
              }
              if (ok) {
                matchIdx = tailStart;
                matchedTier = 0;
              }
            }
            if (matchIdx < 0) {
              return { success: false, error: { code: 'no-match', path: this.path } };
            }
          } else {
            return { success: false, error: { code: 'no-match', path: this.path } };
          }
        }
        
        // Check if endOfFile chunk matches at end
        if (chunk.endOfFile && matchIdx + oldLines.length !== newLines.length) {
          return { success: false, error: { code: 'no-match', path: this.path } };
        }
        
        newLines.splice(matchIdx, oldLines.length, ...newLinesChunk);
        cursor = matchIdx + newLinesChunk.length;
      }
    }
    
    const newContent = newLines.join(file.lineBreak) + (file.endsWithBreak ? file.lineBreak : '');
    if (newContent === file.content && !this.moveTo) {
      return { success: true, changes: [] };
    }
    
    if (this.moveTo) {
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
// JSON edits parsing
// ============================================================================

function parseJsonEdits(text: string): Edit[] {
  const lines = text.split('\n');
  const edits: Edit[] = [];
  
  // Check if it's JSON array or JSON Lines
  const trimmed = text.trimStart();
  if (trimmed.startsWith('[')) {
    // JSON array
    try {
      const arr = JSON.parse(text);
      if (!Array.isArray(arr)) throw new Error('parse 1');
      for (let i = 0; i < arr.length; i++) {
        edits.push(parseJsonEdit(arr[i], i + 1));
      }
    } catch (e) {
      // Find line number of array start
      const firstBracket = text.indexOf('[');
      const lineNo = text.slice(0, firstBracket).split('\n').length;
      throw new Error(`parse ${lineNo}`);
    }
  } else {
    // JSON Lines
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        edits.push(parseJsonEdit(obj, i + 1));
      } catch {
        throw new Error(`parse ${i + 1}`);
      }
    }
  }
  
  if (edits.length === 0) throw new Error('parse 1');
  return edits;
}

function parseJsonEdit(obj: any, lineNo: number): Edit {
  if (!obj || typeof obj !== 'object') throw new Error(`parse ${lineNo}`);
  const path = obj.path;
  const command = obj.command;
  
  if (!path || typeof path !== 'string') throw new Error(`parse ${lineNo}`);
  if (!command || typeof command !== 'string') throw new Error(`parse ${lineNo}`);
  
  if (command === 'create') {
    const fileText = obj.file_text ?? '';
    if (typeof fileText !== 'string') throw new Error(`parse ${lineNo}`);
    return new JsonCreateEdit(path, fileText);
  } else if (command === 'str_replace') {
    const oldStr = obj.old_str;
    const newStr = obj.new_str ?? '';
    if (typeof oldStr !== 'string' || oldStr === '') throw new Error(`parse ${lineNo}`);
    if (typeof newStr !== 'string') throw new Error(`parse ${lineNo}`);
    return new JsonStrReplaceEdit(path, oldStr, newStr);
  } else if (command === 'insert') {
    const insertLine = obj.insert_line;
    const newStr = obj.new_str ?? '';
    if (typeof insertLine !== 'number' || !Number.isInteger(insertLine)) throw new Error(`parse ${lineNo}`);
    if (typeof newStr !== 'string') throw new Error(`parse ${lineNo}`);
    return new JsonInsertEdit(path, insertLine, newStr);
  } else {
    throw new Error(`parse ${lineNo}`);
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
    
    files.set(this.path, { 
      content: this.fileText, 
      lines: this.fileText.split('\n'), 
      lineBreak: '\n', 
      endsWithBreak: this.fileText.endsWith('\n'), 
      exists: true 
    });
    return { success: true, changes: [{ type: 'create', newPath: this.path, content: this.fileText, lineBreak: '\n', endsWithBreak: this.fileText.endsWith('\n') }] };
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
    
    let content = file.content;
    let searchOld = this.oldStr;
    let searchNew = this.newStr;
    
    // Handle CRLF
    if (file.lineBreak === '\r\n') {
      content = content.replace(/\r\n/g, '\n');
      searchOld = searchOld.replace(/\r\n/g, '\n');
      searchNew = searchNew.replace(/\r\n/g, '\n');
    }
    
    // Count occurrences (allowing overlap)
    let count = 0;
    let pos = 0;
    while (true) {
      const idx = content.indexOf(searchOld, pos);
      if (idx < 0) break;
      count++;
      pos = idx + 1; // allow overlap
    }
    
    if (count === 0) return { success: false, error: { code: 'no-match', path: this.path } };
    if (count > 1) return { success: false, error: { code: 'ambiguous', path: this.path } };
    
    const idx = content.indexOf(searchOld);
    const newContent = content.slice(0, idx) + searchNew + content.slice(idx + searchOld.length);
    
    // Write back with original line break
    let finalContent = newContent;
    if (file.lineBreak === '\r\n') {
      finalContent = newContent.replace(/\n/g, '\r\n');
    }
    
    if (finalContent === file.content) {
      return { success: true, changes: [] };
    }
    
    file.content = finalContent;
    file.lines = finalContent.split(file.lineBreak);
    if (file.endsWithBreak) file.lines.pop();
    return { success: true, changes: [{ type: 'modify', newPath: this.path, content: finalContent, lineBreak: file.lineBreak, endsWithBreak: file.endsWithBreak }] };
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
    
    // Parse newStr lines
    const newLines = this.newStr.split('\n');
    if (newLines.length === 1 && newLines[0] === '') newLines.length = 0;
    // Remove trailing \r from each line
    for (let i = 0; i < newLines.length; i++) {
      if (newLines[i].endsWith('\r')) newLines[i] = newLines[i].slice(0, -1);
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
  const trimmed = text.trimStart();
  
  if (trimmed.startsWith('*** Begin Patch')) return 'v4a';
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) return 'json';
  if (trimmed.startsWith('```') || trimmed.includes('<<<<<<< SEARCH')) return 'search-replace';
  if (trimmed.startsWith('--- ') || trimmed.match(/^--- .*\n\+\+\+ /)) return 'unified';
  
  // Check for unified diff anywhere in text (fenced/bare)
  const lines = text.split('\n');
  for (const line of lines) {
    if (line.startsWith('--- ')) return 'unified';
  }
  
  return 'none';
}

// ============================================================================
// Main
// ============================================================================

function parseArgs(args: string[]): { format: string; check: boolean; strict: boolean; patchFile: string | null } {
  const result = { format: 'auto', check: false, strict: false, patchFile: null as string | null };
  let i = 0;
  let afterDashDash = false;
  
  while (i < args.length) {
    const arg = args[i];
    
    if (!afterDashDash && arg === '--') {
      afterDashDash = true;
      i++;
      continue;
    }
    
    if (!afterDashDash && arg.startsWith('-')) {
      if (arg === '-') {
        if (result.patchFile !== null) throw new Error('usage');
        result.patchFile = '-';
      } else if (arg === '--check') {
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
      } else {
        throw new Error('usage');
      }
    } else {
      if (result.patchFile !== null) throw new Error('usage');
      result.patchFile = arg;
    }
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
