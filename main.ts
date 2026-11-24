#!/usr/bin/env node
// mend CLI - applies AI-model edits in unified diff, SEARCH/REPLACE, V4A, and JSON formats

import { readFileSync, writeFileSync, mkdirSync, rmSync, statSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, relative, sep, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stdin as stdinStream } from 'node:process';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================================
// Types
// ============================================================================

interface FileState {
  content: string;
  lines: string[];
  lineBreak: '\n' | '\r\n';
  hasTrailingBreak: boolean;
  originalContent: string;
  exists: boolean;
  deleted: boolean;
  movedFrom?: string;
  movedTo?: string;
}

interface UnifiedHunk {
  oldStart: number; // 0-indexed
  oldCount: number;
  newStart: number; // 0-indexed
  newCount: number;
  oldLines: string[];
  newLines: string[];
  // Line types: 'context', 'added', 'changed'
  newLineTypes: ('context' | 'added' | 'changed')[];
  // For context lines: index in oldLines
  // For changed lines: index in oldLines of the corresponding deleted line
  newLineToOldLineIndex: number[];
}

interface UnifiedFileEdit {
  path: string;
  isCreate: boolean;
  isDelete: boolean;
  isRename: boolean;
  renameFrom?: string;
  renameTo?: string;
  hunks: UnifiedHunk[];
}

interface SearchReplaceEdit {
  path: string;
  oldLines: string[];
  newLines: string[];
}

interface V4AEdit {
  type: 'add' | 'delete' | 'update';
  path: string;
  newPath?: string;
  lines?: string[];
  chunks?: V4AChunk[];
}

interface V4AChunk {
  anchor: string;
  oldLines: string[];
  newLines: string[];
  isEndOfFile: boolean;
}

interface JSONEdit {
  command: 'create' | 'str_replace' | 'insert';
  path: string;
  file_text?: string;
  old_str?: string;
  new_str?: string;
  insert_line?: number;
  new_str_insert?: string;
}

type Tier = 0 | 1 | 2;

// ============================================================================
// Utility functions
// ============================================================================

function isSafePath(path: string): boolean {
  if (path === '' || path.startsWith('/') || path.includes('\\')) return false;
  const segments = path.split('/');
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

function detectLineBreak(text: string): '\n' | '\r\n' {
  const idx = text.indexOf('\n');
  if (idx === -1) return '\n';
  return text[idx - 1] === '\r' ? '\r\n' : '\n';
}

function splitLines(text: string, lineBreak: '\n' | '\r\n'): string[] {
  if (text === '') return [];
  const lines = text.split(lineBreak);
  if (text.endsWith(lineBreak)) {
    lines.pop();
  }
  return lines;
}

function joinLines(lines: string[], lineBreak: '\n' | '\r\n', hasTrailingBreak: boolean): string {
  if (lines.length === 0) return '';
  const result = lines.join(lineBreak);
  return hasTrailingBreak ? result + lineBreak : result;
}

function readFileState(path: string): FileState | null {
  try {
    const content = readFileSync(path, 'utf8');
    const lineBreak = detectLineBreak(content);
    const lines = splitLines(content, lineBreak);
    const hasTrailingBreak = content.endsWith(lineBreak);
    return { content, lines, lineBreak, hasTrailingBreak, originalContent: content, exists: true, deleted: false };
  } catch {
    return null;
  }
}

function writeFileState(path: string, state: FileState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, state.content, 'utf8');
}

function deleteFile(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {}
}

// ============================================================================
// Tier matching (section 5)
// ============================================================================

function normalizeForTier(line: string, tier: Tier): string {
  if (tier === 0) return line;
  if (tier === 1) return line.trimEnd(); // ignore trailing whitespace
  return line.trim(); // tier 2: ignore all whitespace
}

function findMatchAtTier(fileLines: string[], targetLines: string[], start: number, tier: Tier): number[] {
  if (targetLines.length === 0) {
    const matches: number[] = [];
    for (let i = start; i <= fileLines.length; i++) {
      matches.push(i);
    }
    return matches;
  }
  const matches: number[] = [];
  for (let i = start; i <= fileLines.length - targetLines.length; i++) {
    let match = true;
    for (let j = 0; j < targetLines.length; j++) {
      if (normalizeForTier(fileLines[i + j], tier) !== normalizeForTier(targetLines[j], tier)) {
        match = false;
        break;
      }
    }
    if (match) matches.push(i);
  }
  return matches;
}

function matchAtTier(fileLines: string[], targetLines: string[], strict: boolean): { index: number; tier: Tier } | { error: 'no-match' | 'ambiguous' } {
  const tiers: Tier[] = strict ? [0] : [0, 1, 2];
  
  for (const tier of tiers) {
    const matches = findMatchAtTier(fileLines, targetLines, 0, tier);
    if (matches.length === 0) continue;
    if (matches.length > 1) return { error: 'ambiguous' };
    return { index: matches[0], tier };
  }
  return { error: 'no-match' };
}

function matchAtTierFromCursor(fileLines: string[], targetLines: string[], cursor: number, strict: boolean): { index: number; tier: Tier } | { error: 'no-match' | 'ambiguous' } {
  const tiers: Tier[] = strict ? [0] : [0, 1, 2];
  
  for (const tier of tiers) {
    const matches = findMatchAtTier(fileLines, targetLines, cursor, tier);
    if (matches.length === 0) continue;
    if (matches.length > 1) return { error: 'ambiguous' };
    return { index: matches[0], tier };
  }
  return { error: 'no-match' };
}

// ============================================================================
// Tier matching helper (section 5)
// ============================================================================

/**
 * Find the best match for pattern in workingLines, starting from expectedPos.
 * Per SPEC section 5: Try tiers 0, 1, 2 at expected position first,
 * then search outward from expected position (nearest anchor fallback).
 */
function findMatch(
  workingLines: string[],
  pattern: string[],
  expectedPos: number,
  strict: boolean
): { index: number; tier: Tier } | { error: 'no-match' | 'ambiguous' } {
  if (pattern.length === 0) {
    // Empty pattern matches at any position
    return { index: Math.min(Math.max(0, expectedPos), workingLines.length), tier: 0 };
  }
  
  const tiers: Tier[] = strict ? [0] : [0, 1, 2];
  const maxStart = workingLines.length - pattern.length;
  
  // First, try at expected position with all tiers
  if (expectedPos >= 0 && expectedPos <= maxStart) {
    for (const tier of tiers) {
      let match = true;
      for (let j = 0; j < pattern.length; j++) {
        if (normalizeForTier(workingLines[expectedPos + j], tier) !== normalizeForTier(pattern[j], tier)) {
          match = false;
          break;
        }
      }
      if (match) return { index: expectedPos, tier };
    }
  }
  
  // Then search outward from expected position (nearest anchor fallback)
  // For each tier, search expanding distance from expectedPos
  for (const tier of tiers) {
    for (let dist = 1; dist <= maxStart + 1; dist++) {
      let foundAtThisDist = -1;
      let count = 0;
      
      // Check expectedPos - dist
      const leftPos = expectedPos - dist;
      if (leftPos >= 0 && leftPos <= maxStart) {
        let match = true;
        for (let j = 0; j < pattern.length; j++) {
          if (normalizeForTier(workingLines[leftPos + j], tier) !== normalizeForTier(pattern[j], tier)) {
            match = false;
            break;
          }
        }
        if (match) {
          foundAtThisDist = leftPos;
          count++;
        }
      }
      
      // Check expectedPos + dist
      const rightPos = expectedPos + dist;
      if (rightPos >= 0 && rightPos <= maxStart) {
        let match = true;
        for (let j = 0; j < pattern.length; j++) {
          if (normalizeForTier(workingLines[rightPos + j], tier) !== normalizeForTier(pattern[j], tier)) {
            match = false;
            break;
          }
        }
        if (match) {
          if (count === 0) foundAtThisDist = rightPos;
          count++;
        }
      }
      
      if (count === 1) {
        return { index: foundAtThisDist, tier };
      } else if (count > 1) {
        return { error: 'ambiguous' };
      }
    }
  }
  
  // If expectedPos was far off, also do a full file search as last resort
  for (const tier of tiers) {
    const matches: number[] = [];
    for (let i = 0; i <= maxStart; i++) {
      let match = true;
      for (let j = 0; j < pattern.length; j++) {
        if (normalizeForTier(workingLines[i + j], tier) !== normalizeForTier(pattern[j], tier)) {
          match = false;
          break;
        }
      }
      if (match) matches.push(i);
    }
    if (matches.length === 1) {
      return { index: matches[0], tier };
    } else if (matches.length > 1) {
      return { error: 'ambiguous' };
    }
  }
  
  return { error: 'no-match' };
}

/**
 * Find match from cursor position (for V4A chunks)
 */
function findMatchFromCursor(
  workingLines: string[],
  pattern: string[],
  cursor: number,
  strict: boolean
): { index: number; tier: Tier } | { error: 'no-match' | 'ambiguous' } {
  if (pattern.length === 0) {
    return { index: Math.min(Math.max(0, cursor), workingLines.length), tier: 0 };
  }
  
  const tiers: Tier[] = strict ? [0] : [0, 1, 2];
  const maxStart = workingLines.length - pattern.length;
  
  for (const tier of tiers) {
    const matches: number[] = [];
    for (let i = cursor; i <= maxStart; i++) {
      let match = true;
      for (let j = 0; j < pattern.length; j++) {
        if (normalizeForTier(workingLines[i + j], tier) !== normalizeForTier(pattern[j], tier)) {
          match = false;
          break;
        }
      }
      if (match) matches.push(i);
    }
    if (matches.length === 1) {
      return { index: matches[0], tier };
    } else if (matches.length > 1) {
      return { error: 'ambiguous' };
    }
  }
  
  return { error: 'no-match' };
}

// ============================================================================
// Format detection (section 4)
// ============================================================================

function detectFormat(text: string): 'unified' | 'search-replace' | 'v4a' | 'json' | null {
  const trimmed = text.trimStart();
  
  if (trimmed.startsWith('*** Begin Patch')) return 'v4a';
  
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(text.trim());
      if (Array.isArray(parsed)) return 'json';
    } catch {}
    return 'json';
  }
  
  if (text.includes('<<<<<<< SEARCH')) return 'search-replace';
  
  const lines = text.split('\n');
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i].startsWith('--- ') && lines[i + 1].startsWith('+++ ')) {
      // Validate it's a proper unified diff
      const oldPathLine = lines[i].slice(4);
      const newPathLine = lines[i + 1].slice(4);
      // Invalid if paths start with + or have other malformed indicators
      if (oldPathLine.startsWith('+') || newPathLine.startsWith('+')) {
        return null; // Invalid unified diff - treat as no format
      }
      return 'unified';
    }
  }
  
  return null;
}

// ============================================================================
// Unified diff parser (section 6)
// ============================================================================

function parseUnifiedDiff(text: string): UnifiedFileEdit[] {
  const lines = text.split('\n');
  const edits: UnifiedFileEdit[] = [];
  let i = 0;
  
  // Skip leading non-diff lines (for fenced/bare diffs)
  while (i < lines.length && !lines[i].startsWith('--- ')) {
    i++;
  }
  
  while (i < lines.length) {
    // Find next file header
    while (i < lines.length && !lines[i].startsWith('--- ')) {
      i++;
    }
    if (i >= lines.length) break;
    
    const oldPathLine = lines[i].slice(4);
    i++;
    
    if (i >= lines.length || !lines[i].startsWith('+++ ')) {
      throw new Error(`parse ${i + 1}`);
    }
    const newPathLine = lines[i].slice(4);
    i++;
    
    // Parse paths - strip a/ b/ prefixes
    const oldPath = oldPathLine.startsWith('a/') || oldPathLine.startsWith('b/') ? oldPathLine.slice(2) : oldPathLine;
    const newPath = newPathLine.startsWith('a/') || newPathLine.startsWith('b/') ? newPathLine.slice(2) : newPathLine;
    
    // Check for git rename headers
    let isRename = false;
    let renameFrom = '';
    let renameTo = '';
    while (i < lines.length && lines[i].startsWith('rename ')) {
      if (lines[i].startsWith('rename from ')) {
        renameFrom = lines[i].slice('rename from '.length);
      } else if (lines[i].startsWith('rename to ')) {
        renameTo = lines[i].slice('rename to '.length);
        isRename = true;
      }
      i++;
    }
    
    const isCreate = oldPath === '/dev/null';
    const isDelete = newPath === '/dev/null';
    const path = isCreate ? newPath : oldPath;
    
    if (!isSafePath(path)) throw new Error(`parse ${i}`);
    
    const hunks: UnifiedHunk[] = [];
    
    while (i < lines.length) {
      if (lines[i].startsWith('--- ')) break;
      
      // Skip empty lines between hunks
      if (lines[i] === '') {
        i++;
        continue;
      }
      
      // Parse hunk header: @@ -oldStart,oldCount +newStart,newCount @@
      const hunkMatch = lines[i].match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (!hunkMatch) {
        // Not a hunk header - skip trailing text and continue to next file
        i++;
        continue;
      }
      
      const oldStart = parseInt(hunkMatch[1], 10) - 1; // Convert to 0-indexed
      const oldCount = hunkMatch[2] ? parseInt(hunkMatch[2], 10) : 1;
      const newStart = parseInt(hunkMatch[3], 10) - 1; // Convert to 0-indexed
      const newCount = hunkMatch[4] ? parseInt(hunkMatch[4], 10) : 1;
      
      i++;
      const oldLines: string[] = [];
      const newLines: string[] = [];
      const newLineTypes: ('context' | 'added' | 'changed')[] = [];
      const newLineToOldLineIndex: number[] = [];
      
      // Read hunk lines: oldCount lines from old file (context + -), newCount from new (context + +)
      let oldLineIdx = 0;
      const deletedOldIndices: number[] = [];
      while (i < lines.length && (oldLines.length < oldCount || newLines.length < newCount)) {
        const line = lines[i];
        if (line.startsWith('--- ')) break;
        
        // Check for explicit diff prefixes
        if (line.startsWith(' ')) {
          // Explicit context line (starts with single space)
          oldLines.push(line.slice(1));
          newLines.push(line.slice(1));
          newLineTypes.push('context');
          newLineToOldLineIndex.push(oldLineIdx);
          oldLineIdx++;
        } else if (line.startsWith('-')) {
          // Deleted line - only in oldLines, not in newLines
          oldLines.push(line.slice(1));
          deletedOldIndices.push(oldLineIdx);
          oldLineIdx++;
        } else if (line.startsWith('+')) {
          // Added line - check if it corresponds to a deleted line (a change)
          newLines.push(line.slice(1));
          const addedSoFar = newLineTypes.filter(t => t === 'added' || t === 'changed').length;
          if (addedSoFar < deletedOldIndices.length) {
            // This added line corresponds to a deleted line - it's a change
            newLineTypes.push('changed');
            newLineToOldLineIndex.push(deletedOldIndices[addedSoFar]);
          } else {
            newLineTypes.push('added');
            newLineToOldLineIndex.push(-1);
          }
        } else if (line === '') {
          // Empty context line
          oldLines.push('');
          newLines.push('');
          newLineTypes.push('context');
          newLineToOldLineIndex.push(oldLineIdx);
          oldLineIdx++;
        } else {
          // Bare diff: line without prefix - treat as context
          oldLines.push(line);
          newLines.push(line);
          newLineTypes.push('context');
          newLineToOldLineIndex.push(oldLineIdx);
          oldLineIdx++;
        }
        i++;
      }
      
      // Verify we got the right number of lines
      if (oldLines.length !== oldCount || newLines.length !== newCount) {
        throw new Error(`parse ${i + 1}`);
      }
      
      hunks.push({ oldStart, oldCount, newStart, newCount, oldLines, newLines, newLineTypes, newLineToOldLineIndex });
    }
    
    if (hunks.length > 0) {
      edits.push({ path, isCreate, isDelete, isRename, renameFrom: isRename ? renameFrom : undefined, renameTo: isRename ? renameTo : undefined, hunks });
    }
  }
  
  if (edits.length === 0) throw new Error('parse 1');
  return edits;
}

// ============================================================================
// Search/Replace parser (section 7)
// ============================================================================

function parseSearchReplace(text: string): SearchReplaceEdit[] {
  const lines = text.split('\n');
  const edits: SearchReplaceEdit[] = [];
  let i = 0;
  
  while (i < lines.length) {
    // Skip empty lines only (not fence markers)
    while (i < lines.length && lines[i].trim() === '') {
      i++;
    }
    if (i >= lines.length) break;
    
    const path = lines[i].trim();
    if (!isSafePath(path)) throw new Error(`parse ${i + 1}`);
    i++;
    
    // Find next non-empty line (should be fence)
    while (i < lines.length && lines[i].trim() === '') i++;
    if (i >= lines.length) throw new Error(`parse ${i + 1}`);
    
    // Should be ```x or similar fence opening (any characters after ```)
    if (!lines[i].startsWith('```')) {
      throw new Error(`parse ${i + 1}`);
    }
    i++; // Skip fence opening
    
    const blockLines: string[] = [];
    while (i < lines.length && !lines[i].startsWith('```')) {
      blockLines.push(lines[i]);
      i++;
    }
    
    if (i >= lines.length) throw new Error(`parse ${i + 1}`);
    i++; // Skip fence closing (any ```... line)
    
    let inSearch = false;
    let inReplace = false;
    const searchLines: string[] = [];
    const replaceLines: string[] = [];
    
    for (const bl of blockLines) {
      if (bl === '<<<<<<< SEARCH') {
        inSearch = true;
        inReplace = false;
      } else if (bl === '=======') {
        inSearch = false;
        inReplace = true;
      } else if (bl === '>>>>>>> REPLACE') {
        inSearch = false;
        inReplace = false;
      } else if (inSearch) {
        searchLines.push(bl);
      } else if (inReplace) {
        replaceLines.push(bl);
      }
    }
    
    edits.push({ path, oldLines: searchLines, newLines: replaceLines });
  }
  
  if (edits.length === 0) throw new Error('parse 1');
  return edits;
}

// ============================================================================
// V4A parser (section 8)
// ============================================================================

function parseV4A(text: string): V4AEdit[] {
  const lines = text.split('\n');
  const edits: V4AEdit[] = [];
  
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (i >= lines.length || lines[i].trim() !== '*** Begin Patch') {
    throw new Error(`parse ${i + 1}`);
  }
  i++;
  
  let lastNonBlank = lines.length - 1;
  while (lastNonBlank >= 0 && lines[lastNonBlank].trim() === '') lastNonBlank--;
  if (lastNonBlank < 0 || lines[lastNonBlank].trim() !== '*** End Patch') {
    throw new Error(`parse ${lines.length + 1}`);
  }
  
  while (i <= lastNonBlank) {
    const line = lines[i];
    const trimmed = line.trim();
    
    if (trimmed === '') {
      i++;
      continue;
    }
    
    if (trimmed.startsWith('*** Add File: ')) {
      const path = trimmed.slice('*** Add File: '.length).trim();
      if (!isSafePath(path)) throw new Error(`parse ${i + 1}`);
      i++;
      const fileLines: string[] = [];
      while (i <= lastNonBlank) {
        const l = lines[i];
        const tl = l.trim();
        if (tl.startsWith('*** ')) break;
        if (l.startsWith('+')) {
          fileLines.push(l.slice(1));
        } else if (l === '') {
          fileLines.push('');
        } else {
          throw new Error(`parse ${i + 1}`);
        }
        i++;
      }
      edits.push({ type: 'add', path, lines: fileLines });
    } else if (trimmed.startsWith('*** Delete File: ')) {
      const path = trimmed.slice('*** Delete File: '.length).trim();
      if (!isSafePath(path)) throw new Error(`parse ${i + 1}`);
      i++;
      edits.push({ type: 'delete', path });
    } else if (trimmed.startsWith('*** Update File: ')) {
      const path = trimmed.slice('*** Update File: '.length).trim();
      if (!isSafePath(path)) throw new Error(`parse ${i + 1}`);
      i++;
      
      let newPath: string | undefined;
      const chunks: V4AChunk[] = [];
      
      if (i <= lastNonBlank && lines[i].trim().startsWith('*** Move to: ')) {
        newPath = lines[i].trim().slice('*** Move to: '.length).trim();
        if (!isSafePath(newPath)) throw new Error(`parse ${i + 1}`);
        i++;
      }
      
      let currentChunk: V4AChunk | null = null;
      
      while (i <= lastNonBlank) {
        const l = lines[i];
        const tl = l.trim();
        if (tl.startsWith('*** ')) break;
        
        if (tl === '' && (i + 1 > lastNonBlank || lines[i + 1].trim().startsWith('***'))) {
          break;
        }
        
        if (l.startsWith('@@')) {
          if (currentChunk) chunks.push(currentChunk);
          currentChunk = { anchor: l.slice(2).trim(), oldLines: [], newLines: [], isEndOfFile: false };
          i++;
          continue;
        }
        
        if (tl === '*** End of File') {
          if (currentChunk) {
            currentChunk.isEndOfFile = true;
            chunks.push(currentChunk);
            currentChunk = null;
          }
          i++;
          continue;
        }
        
        if (!currentChunk) {
          currentChunk = { anchor: '', oldLines: [], newLines: [], isEndOfFile: false };
        }
        
        // Check the FIRST CHARACTER of the original line (not trimmed)
        const firstChar = l[0];
        if (firstChar === ' ' || l === '') {
          currentChunk.oldLines.push(l.slice(1));
          currentChunk.newLines.push(l.slice(1));
        } else if (firstChar === '-') {
          currentChunk.oldLines.push(l.slice(1));
        } else if (firstChar === '+') {
          currentChunk.newLines.push(l.slice(1));
        } else {
          throw new Error(`parse ${i + 1}`);
        }
        i++;
      }
      
      if (currentChunk) chunks.push(currentChunk);
      
      if (chunks.length === 0 && !newPath) {
        throw new Error(`parse ${i}`);
      }
      
      edits.push({ type: 'update', path, newPath, chunks });
    } else {
      throw new Error(`parse ${i + 1}`);
    }
  }
  
  if (edits.length === 0) throw new Error('parse 1');
  return edits;
}

// ============================================================================
// JSON parser (section 9)
// ============================================================================

function parseJSONEdits(text: string): JSONEdit[] {
  const trimmed = text.trim();
  
  // Try as JSON array
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed.map((obj, idx) => parseJSONEdit(obj, idx + 1));
    }
  } catch {}
  
  // Try as JSON Lines
  const lines = text.split('\n');
  const edits: JSONEdit[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') continue;
    try {
      const obj = JSON.parse(line);
      edits.push(parseJSONEdit(obj, i + 1));
    } catch {
      throw new Error(`parse ${i + 1}`);
    }
  }
  
  if (edits.length === 0) throw new Error('parse 1');
  return edits;
}

function parseJSONEdit(obj: any, lineNum: number): JSONEdit {
  if (!obj.path || typeof obj.path !== 'string') throw new Error(`parse ${lineNum}`);
  if (!isSafePath(obj.path)) throw new Error(`parse ${lineNum}`);
  if (!obj.command || typeof obj.command !== 'string') throw new Error(`parse ${lineNum}`);
  
  switch (obj.command) {
    case 'create':
      if (typeof obj.file_text !== 'string') throw new Error(`parse ${lineNum}`);
      return { command: 'create', path: obj.path, file_text: obj.file_text };
    case 'str_replace':
      if (typeof obj.old_str !== 'string' || obj.old_str === '') throw new Error(`parse ${lineNum}`);
      return { command: 'str_replace', path: obj.path, old_str: obj.old_str, new_str: obj.new_str ?? '' };
    case 'insert':
      if (typeof obj.insert_line !== 'number' || !Number.isInteger(obj.insert_line)) throw new Error(`parse ${lineNum}`);
      return { command: 'insert', path: obj.path, insert_line: obj.insert_line, new_str_insert: obj.new_str ?? '' };
    default:
      throw new Error(`parse ${lineNum}`);
  }
}

// ============================================================================
// Edit Applier
// ============================================================================

class EditApplier {
  files = new Map<string, FileState>();
  errors: { code: string; path: string }[] = [];
  strict: boolean;
  checkMode: boolean;
  totalEdits = 0;
  
  constructor(strict: boolean, checkMode: boolean) {
    this.strict = strict;
    this.checkMode = checkMode;
  }
  
  getFile(path: string): FileState {
    let file = this.files.get(path);
    if (!file) {
      file = readFileState(path);
      if (file) this.files.set(path, file);
      else file = { content: '', lines: [], lineBreak: '\n', hasTrailingBreak: false, originalContent: '', exists: false, deleted: false };
    }
    return file;
  }
  
  applyUnified(edit: UnifiedFileEdit): void {
    this.totalEdits++;
    const { path, isCreate, isDelete, hunks } = edit;
    
    if (!isSafePath(path)) {
      this.errors.push({ code: 'unsafe', path });
      return;
    }
    
        if (isCreate) {
      if (this.getFile(path).exists) {
        this.errors.push({ code: 'exists', path });
        return;
      }
      
      // Build new file from all hunks' newLines
      const newLines: string[] = [];
      for (const hunk of hunks) {
        for (const line of hunk.newLines) {
          newLines.push(line);
        }
      }
      
      const file: FileState = {
        content: joinLines(newLines, '\n', true),
        lines: newLines,
        lineBreak: '\n',
        hasTrailingBreak: true,
        originalContent: '',
        exists: true,
        deleted: false
      };
      this.files.set(path, file);
      return;
    }
    
    // Handle rename (move)
    if (edit.isRename && edit.renameTo) {
      const oldPath = edit.renameFrom || path;
      const newPath = edit.renameTo;
      
      if (!isSafePath(oldPath)) {
        this.errors.push({ code: 'unsafe', path: oldPath });
        return;
      }
      if (!isSafePath(newPath)) {
        this.errors.push({ code: 'unsafe', path: newPath });
        return;
      }
      
      const oldFile = this.getFile(oldPath);
      if (!oldFile.exists) {
        this.errors.push({ code: 'missing', path: oldPath });
        return;
      }
      
      const newFileState = this.getFile(newPath);
      if (newFileState.exists) {
        this.errors.push({ code: 'exists', path: newPath });
        return;
      }
      
      // Apply hunks to the file content
      let workingLines = [...oldFile.lines];
      let lineDelta = 0;
      
      for (const hunk of hunks) {
        let expectedPos: number;
        if (hunk.oldCount === 0) {
          expectedPos = hunk.newStart + lineDelta;
        } else {
          expectedPos = hunk.oldStart + lineDelta;
        }
        
        const pattern = hunk.oldLines;
        const replacementLines = hunk.newLines;
        
        if (pattern.length === 0) {
          const insertPos = Math.min(Math.max(0, expectedPos), workingLines.length);
          workingLines.splice(insertPos, 0, ...replacementLines);
          lineDelta += replacementLines.length;
          continue;
        }
        
        const matchResult = findMatch(workingLines, pattern, expectedPos, this.strict);
        if ('error' in matchResult) {
          this.errors.push({ code: matchResult.error, path: oldPath });
          return;
        }
        
        const { index: matchIdx, tier: matchTier } = matchResult;
        
        const newLines = hunk.newLines;
        const newLineTypes = hunk.newLineTypes;
        const newLineToOldLineIndex = hunk.newLineToOldLineIndex;
        
        const replacement: string[] = [];
        for (let j = 0; j < newLines.length; j++) {
          if (newLineTypes[j] === 'context') {
            const oldLineIdx = newLineToOldLineIndex[j];
            if (oldLineIdx >= 0 && oldLineIdx < hunk.oldLines.length) {
              replacement.push(workingLines[matchIdx + oldLineIdx]);
            } else {
              replacement.push(workingLines[matchIdx + j]);
            }
          } else if (newLineTypes[j] === 'changed') {
            // Changed line: use file's whitespace from the corresponding deleted line's position
            const oldLineIdx = newLineToOldLineIndex[j];
            if (oldLineIdx >= 0 && oldLineIdx < hunk.oldLines.length) {
              const fileLine = workingLines[matchIdx + oldLineIdx];
              const wsMatch = fileLine.match(/^(\s*)/);
              const leadingWs = wsMatch ? wsMatch[1] : '';
              replacement.push(leadingWs + newLines[j].trimStart());
            } else {
              replacement.push(newLines[j]);
            }
          } else {
            // Pure added line - use patch's whitespace
            replacement.push(newLines[j]);
          }
        }
        
        workingLines.splice(matchIdx, pattern.length, ...replacement);
        lineDelta += replacement.length - pattern.length;
      }
      
      const newContent = joinLines(workingLines, oldFile.lineBreak, oldFile.hasTrailingBreak);
      
      // Mark old file as deleted, create new file
      oldFile.deleted = true;
      oldFile.movedTo = newPath;
      
      const newFile: FileState = {
        content: newContent,
        lines: workingLines,
        lineBreak: oldFile.lineBreak,
        hasTrailingBreak: oldFile.hasTrailingBreak,
        originalContent: '',
        exists: true,
        deleted: false,
        movedFrom: oldPath
      };
      this.files.set(newPath, newFile);
      return;
    }
    
    if (isDelete) {
      const file = this.getFile(path);
      if (!file.exists) {
        this.errors.push({ code: 'missing', path });
        return;
      }
      file.deleted = true;
      return;
    }
    
    // Modify existing file
    const file = this.getFile(path);
    if (!file.exists) {
      this.errors.push({ code: 'missing', path });
      return;
    }
    
    let workingLines = [...file.lines];
    let lineDelta = 0; // cumulative change in line count
    
        
    for (const hunk of hunks) {
            // For insertions (oldCount === 0), use newStart as the insertion point
      // For other hunks, use oldStart + delta
      let expectedPos: number;
      if (hunk.oldCount === 0) {
        expectedPos = hunk.newStart + lineDelta;
      } else {
        expectedPos = hunk.oldStart + lineDelta;
      }
      
      // Search pattern is the oldLines (context + deleted)
      const pattern = hunk.oldLines;
      const replacementLines = hunk.newLines; // context + added
      
      if (pattern.length === 0) {
        // Pure insertion
        const insertPos = Math.min(Math.max(0, expectedPos), workingLines.length);
        workingLines.splice(insertPos, 0, ...replacementLines);
        lineDelta += replacementLines.length;
        continue;
      }
      
      // Find match using tier matching with nearest anchor fallback
      const matchResult = findMatch(workingLines, pattern, expectedPos, this.strict);
      if ('error' in matchResult) {
        this.errors.push({ code: matchResult.error, path });
        return;
      }
      
      const { index: matchIdx, tier: matchTier } = matchResult;
      
            
      // Build replacement: context lines use file's whitespace, added lines use patch's whitespace
      // Use the pre-computed newLineTypes from parsing
      const newLines = hunk.newLines;
      const newLineTypes = hunk.newLineTypes;
      const newLineToOldLineIndex = hunk.newLineToOldLineIndex;
      
      const replacement: string[] = [];
      for (let j = 0; j < newLines.length; j++) {
        if (newLineTypes[j] === 'context') {
          // Context line - use the matched file's line (preserves file's whitespace)
          const oldLineIdx = newLineToOldLineIndex[j];
          if (oldLineIdx >= 0 && oldLineIdx < hunk.oldLines.length) {
            replacement.push(workingLines[matchIdx + oldLineIdx]);
          } else {
            replacement.push(workingLines[matchIdx + j]);
          }
          // At tier 1, we matched ignoring trailing whitespace, so the file's line
          // already has the correct trailing whitespace (which we're using)
        } else if (newLineTypes[j] === 'changed') {
          // Changed line - at tier > 0, use file's leading whitespace; at tier 0, use patch's
          const oldLineIdx = newLineToOldLineIndex[j];
          if (matchTier > 0 && oldLineIdx >= 0 && oldLineIdx < hunk.oldLines.length) {
            // Preserve file's leading whitespace, use patch's rest
            const fileLine = workingLines[matchIdx + oldLineIdx];
            const wsMatch = fileLine.match(/^(\s*)/);
            const fileWs = wsMatch ? wsMatch[1] : '';
            // Find leading whitespace in patch line
            const patchWsMatch = newLines[j].match(/^(\s*)/);
            const patchWs = patchWsMatch ? patchWsMatch[1] : '';
            // Replace leading whitespace
            replacement.push(fileWs + newLines[j].slice(patchWs.length));
          } else {
            replacement.push(newLines[j]);
          }
        } else {
          // Pure added line - use patch's whitespace
          replacement.push(newLines[j]);
        }
      }
      
            // Replace
      workingLines.splice(matchIdx, pattern.length, ...replacement);
      lineDelta += replacement.length - pattern.length;
          }
    
    file.lines = workingLines;
    file.content = joinLines(workingLines, file.lineBreak, file.hasTrailingBreak);
  }
  
  applySearchReplace(edit: SearchReplaceEdit): void {
    this.totalEdits++;
    const { path, oldLines, newLines } = edit;
    
    if (!isSafePath(path)) {
      this.errors.push({ code: 'unsafe', path });
      return;
    }
    
    const file = this.getFile(path);
    
    if (oldLines.length === 0) {
      // Create new file
      if (file.exists) {
        this.errors.push({ code: 'exists', path });
        return;
      }
      file.content = joinLines(newLines, '\n', true);
      file.lines = newLines;
      file.lineBreak = '\n';
      file.hasTrailingBreak = true;
      file.exists = true;
      file.deleted = false;
      return;
    }
    
    if (!file.exists) {
      this.errors.push({ code: 'missing', path });
      return;
    }
    
    const result = findMatch(file.lines, oldLines, 0, this.strict);
    if ('error' in result) {
      this.errors.push({ code: result.error, path });
      return;
    }
    
    const { index } = result;
    file.lines = [
      ...file.lines.slice(0, index),
      ...newLines,
      ...file.lines.slice(index + oldLines.length)
    ];
    file.content = joinLines(file.lines, file.lineBreak, file.hasTrailingBreak);
  }
  
  applyV4A(edit: V4AEdit): void {
    this.totalEdits++;
    const { type, path, newPath, lines, chunks } = edit;
    
    if (!isSafePath(path)) {
      this.errors.push({ code: 'unsafe', path });
      return;
    }
    if (newPath && !isSafePath(newPath)) {
      this.errors.push({ code: 'unsafe', path: newPath });
      return;
    }
    
    if (type === 'add') {
      if (this.getFile(path).exists) {
        this.errors.push({ code: 'exists', path });
        return;
      }
      const file: FileState = {
        content: joinLines(lines ?? [], '\n', true),
        lines: lines ?? [],
        lineBreak: '\n',
        hasTrailingBreak: true,
        originalContent: '',
        exists: true,
        deleted: false
      };
      this.files.set(path, file);
      return;
    }
    
    if (type === 'delete') {
      const file = this.getFile(path);
      if (!file.exists) {
        this.errors.push({ code: 'missing', path });
        return;
      }
      file.deleted = true;
      return;
    }
    
    // Update
    const file = this.getFile(path);
    if (!file.exists) {
      this.errors.push({ code: 'missing', path });
      return;
    }
    
    if (newPath && this.getFile(newPath).exists) {
      this.errors.push({ code: 'exists', path: newPath });
      return;
    }
    
    let workingLines = [...file.lines];
    let cursor = 0;
    
    for (const chunk of chunks ?? []) {
      // Handle anchor
      if (chunk.anchor) {
        const result = findMatchFromCursor(workingLines, [chunk.anchor], cursor, this.strict);
        if ('error' in result) {
          this.errors.push({ code: 'no-match', path });
          return;
        }
        cursor = result.index + 1;
      }
      
      const oldPattern = chunk.oldLines;
      const newPattern = chunk.newLines;
      
      if (oldPattern.length === 0) {
        // Insert at cursor
        const insertPos = chunk.isEndOfFile ? workingLines.length : cursor;
        workingLines.splice(insertPos, 0, ...newPattern);
        cursor = insertPos + newPattern.length;
        continue;
      }
      
      // Find match at or after cursor
      const matchResult = findMatchFromCursor(workingLines, oldPattern, cursor, this.strict);
      if ('error' in matchResult) {
        this.errors.push({ code: matchResult.error, path });
        return;
      }
      
      const matchIdx = matchResult.index;
      const matchTier = matchResult.tier;
      
      // Check end-of-file constraint
      if (chunk.isEndOfFile && matchIdx + oldPattern.length !== workingLines.length) {
        this.errors.push({ code: 'no-match', path });
        return;
      }
      
      workingLines.splice(matchIdx, oldPattern.length, ...newPattern);
      cursor = matchIdx + newPattern.length;
    }
    
    const newContent = joinLines(workingLines, file.lineBreak, file.hasTrailingBreak);
    
    if (newPath) {
      // Move: write to new path, delete old
      file.deleted = true;
      file.movedTo = newPath;
      const newFile: FileState = {
        content: newContent,
        lines: workingLines,
        lineBreak: file.lineBreak,
        hasTrailingBreak: file.hasTrailingBreak,
        originalContent: '',
        exists: true,
        deleted: false,
        movedFrom: path
      };
      this.files.set(newPath, newFile);
    } else {
      file.lines = workingLines;
      file.content = newContent;
    }
  }
  
  applyJSON(edit: JSONEdit): void {
    this.totalEdits++;
    const { command, path } = edit;
    
    if (!isSafePath(path)) {
      this.errors.push({ code: 'unsafe', path });
      return;
    }
    
    const file = this.getFile(path);
    
    switch (command) {
      case 'create': {
        if (file.exists && !file.deleted) {
          this.errors.push({ code: 'exists', path });
          return;
        }
        const text = edit.file_text ?? '';
        file.content = text;
        file.lineBreak = detectLineBreak(text) || '\n';
        file.lines = splitLines(text, file.lineBreak);
        file.hasTrailingBreak = text.endsWith(file.lineBreak);
        file.exists = true;
        file.deleted = false;
        return;
      }
      
      case 'str_replace': {
        if (!file.exists || file.deleted) {
          this.errors.push({ code: 'missing', path });
          return;
        }
        const oldStr = edit.old_str ?? '';
        const newStr = edit.new_str ?? '';
        
        let content = file.content;
        let searchOld = oldStr;
        let searchNew = newStr;
        
        if (file.lineBreak === '\r\n') {
          content = content.replace(/\r\n/g, '\n');
          searchOld = searchOld.replace(/\r\n/g, '\n');
          searchNew = searchNew.replace(/\r\n/g, '\n');
        }
        
        let count = 0;
        let pos = 0;
        while ((pos = content.indexOf(searchOld, pos)) !== -1) {
          count++;
          pos += 1;
        }
        
        if (count === 0) {
          this.errors.push({ code: 'no-match', path });
          return;
        }
        if (count > 1) {
          this.errors.push({ code: 'ambiguous', path });
          return;
        }
        
        const idx = content.indexOf(searchOld);
        const newContent = content.slice(0, idx) + searchNew + content.slice(idx + searchOld.length);
        
        if (file.lineBreak === '\r\n') {
          file.content = newContent.replace(/\n/g, '\r\n');
        } else {
          file.content = newContent;
        }
        file.lines = splitLines(file.content, file.lineBreak);
        file.hasTrailingBreak = file.content.endsWith(file.lineBreak);
        return;
      }
      
      case 'insert': {
        if (!file.exists || file.deleted) {
          this.errors.push({ code: 'missing', path });
          return;
        }
        const insertLine = edit.insert_line ?? 0;
        const newStr = edit.new_str_insert ?? edit.new_str ?? '';
        
        if (insertLine < 0 || insertLine > file.lines.length) {
          this.errors.push({ code: 'no-match', path });
          return;
        }
        
        const newLines = newStr.split('\n').map(l => l.replace(/\r$/, ''));
        if (newLines.length > 0 && newLines[newLines.length - 1] === '' && newStr.endsWith('\n')) {
          newLines.pop();
        }
        
        file.lines = [
          ...file.lines.slice(0, insertLine),
          ...newLines,
          ...file.lines.slice(insertLine),
        ];
        file.content = joinLines(file.lines, file.lineBreak, file.hasTrailingBreak);
        return;
      }
    }
  }
  
  finalize(): { path: string; action: 'A' | 'D' | 'M' | 'R'; oldPath?: string }[] {
    const results: { path: string; action: 'A' | 'D' | 'M' | 'R'; oldPath?: string }[] = [];
    const moves: { from: string; to: string }[] = [];
    
    // First pass: identify all moves
    for (const [path, file] of this.files) {
      if (file.movedFrom) {
        moves.push({ from: file.movedFrom, to: path });
      }
    }
    
    // Second pass: collect results
    const changedPaths = new Set<string>();
    for (const [path, file] of this.files) {
      if (file.deleted && file.movedTo) continue; // Handled by move
      if (file.deleted && file.exists) {
        changedPaths.add(path);
      } else if (file.exists && !file.deleted && file.originalContent === '' && file.content !== '') {
        // File was created (didn't exist before)
        changedPaths.add(path);
      } else if (file.exists && !file.deleted && file.content !== file.originalContent) {
        // File was modified
        changedPaths.add(path);
      } else if (file.exists && !file.deleted && file.movedFrom) {
        // Move destination
        changedPaths.add(path);
      }
    }
    
    // Sort by UTF-8 byte order
    const sortedPaths = Array.from(changedPaths).sort((a, b) => Buffer.from(a).compare(Buffer.from(b)));
    
    for (const path of sortedPaths) {
      const file = this.files.get(path)!;
      
      // Check if this is a move destination
      const move = moves.find(m => m.to === path);
      if (move) {
        results.push({ path: move.to, action: 'R', oldPath: move.from });
        continue;
      }
      
      // Check if this is a move source
      const moveFrom = moves.find(m => m.from === path);
      if (moveFrom) {
        // Source is handled as part of the R entry
        continue;
      }
      
      if (file.deleted) {
        results.push({ path, action: 'D' });
      } else if (file.originalContent === '' && file.content !== '') {
        // Created file
        results.push({ path, action: 'A' });
      } else if (file.content !== file.originalContent) {
        // Modified file
        results.push({ path, action: 'M' });
      }
    }
    
    return results;
  }
  
  writeFiles(): void {
    if (this.checkMode) return;
    
    for (const [path, file] of this.files) {
      if (file.deleted && !file.movedTo) {
        if (existsSync(path)) rmSync(path);
      } else if (file.exists && !file.deleted) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, file.content);
      }
    }
  }
}

// ============================================================================
// Main
// ============================================================================

async function readPatch(patchPath: string | null): Promise<string> {
  if (patchPath === null) {
    return new Promise((resolve, reject) => {
      let data = '';
      stdinStream.on('data', (chunk: Buffer) => { data += chunk.toString('utf8'); });
      stdinStream.on('end', () => resolve(data));
      stdinStream.on('error', reject);
    });
  } else {
    try {
      return readFileSync(patchPath, 'utf8');
    } catch {
      throw new Error('no-patch');
    }
  }
}

function parseArgs(argv: string[]): { format: 'auto' | 'unified' | 'search-replace' | 'v4a' | 'json'; check: boolean; strict: boolean; patchPath: string | null } {
  const result = {
    format: 'auto' as 'auto' | 'unified' | 'search-replace' | 'v4a' | 'json',
    check: false,
    strict: false,
    patchPath: null as string | null,
  };
  
  let afterSeparator = false;
  let positionalCount = 0;
  const seenOptions = new Set<string>();
  
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    
    if (!afterSeparator && arg === '--') {
      afterSeparator = true;
      continue;
    }
    
    if (!afterSeparator && arg.startsWith('-') && arg !== '-') {
      if (arg.startsWith('--format=')) {
        const value = arg.slice('--format='.length);
        if (seenOptions.has('--format')) throw new Error('usage');
        seenOptions.add('--format');
        if (!['auto', 'unified', 'search-replace', 'v4a', 'json'].includes(value)) throw new Error('usage');
        result.format = value as typeof result.format;
      } else if (arg === '--check') {
        if (seenOptions.has('--check')) throw new Error('usage');
        seenOptions.add('--check');
        result.check = true;
      } else if (arg === '--strict') {
        if (seenOptions.has('--strict')) throw new Error('usage');
        seenOptions.add('--strict');
        result.strict = true;
      } else {
        throw new Error('usage');
      }
    } else {
      positionalCount++;
      if (positionalCount > 1) throw new Error('usage');
      result.patchPath = arg === '-' ? null : arg;
    }
  }
  
  return result;
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const patchText = await readPatch(args.patchPath);
    
    let format = args.format;
    if (format === 'auto') {
      const detected = detectFormat(patchText);
      if (!detected) { console.log('error: format'); process.exit(2); }
      format = detected;
    }
    
    const applier = new EditApplier(args.strict, args.check);
    
    try {
      switch (format) {
        case 'unified': {
          const edits = parseUnifiedDiff(patchText);
          for (const edit of edits) applier.applyUnified(edit);
          break;
        }
        case 'search-replace': {
          const edits = parseSearchReplace(patchText);
          for (const edit of edits) applier.applySearchReplace(edit);
          break;
        }
        case 'v4a': {
          const edits = parseV4A(patchText);
          for (const edit of edits) applier.applyV4A(edit);
          break;
        }
        case 'json': {
          const edits = parseJSONEdits(patchText);
          for (const edit of edits) applier.applyJSON(edit);
          break;
        }
      }
    } catch (e: any) {
      if (e.message.startsWith('parse ')) { console.log(`error: ${e.message}`); process.exit(2); }
      throw e;
    }
    
    if (applier.errors.length > 0) {
      for (const err of applier.errors) console.log(`error: ${err.code} ${err.path}`);
      console.log(`failed: ${applier.errors.length} of ${applier.totalEdits} edits`);
      process.exit(1);
    }
    
    const results = applier.finalize();
    applier.writeFiles();
    
    for (const r of results) {
      if (r.action === 'R') console.log(`R ${r.path} -> ${r.oldPath}`);
      else console.log(`${r.action} ${r.path}`);
    }
    
    const n = results.length;
    console.log(`ok: ${n} file${n === 1 ? '' : 's'}`);
    process.exit(0);
    
  } catch (e: any) {
    if (e.message === 'usage') { console.log('error: usage'); process.exit(2); }
    if (e.message === 'no-patch') { console.log('error: no-patch'); process.exit(2); }
    throw e;
  }
}

main().catch(e => { console.error(e); process.exit(1); });
