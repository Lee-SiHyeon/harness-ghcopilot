'use strict';

const fs = require('fs');
const { TODOS_PATH } = require('./paths.js');

const VALID_STATUSES = new Set(['not-started', 'in-progress', 'completed']);

function readRaw() {
  try {
    return JSON.parse(fs.readFileSync(TODOS_PATH, 'utf8'));
  } catch (_) {
    return { ts: new Date().toISOString(), todos: [] };
  }
}

function writeRaw(data) {
  fs.writeFileSync(TODOS_PATH, JSON.stringify(data, null, 2), 'utf8');
}

function getTodos() {
  return readRaw();
}

function updateTodo(id, status) {
  if (!VALID_STATUSES.has(status)) {
    throw new Error(`Invalid status: ${status}. Must be one of: not-started, in-progress, completed`);
  }
  const data = readRaw();
  const todo = data.todos.find((t) => t.id === id);
  if (!todo) throw new Error(`Todo id ${id} not found`);
  todo.status = status;
  data.ts = new Date().toISOString();
  writeRaw(data);
  return data;
}

function createTodo(title, status = 'not-started') {
  if (!VALID_STATUSES.has(status)) {
    throw new Error(`Invalid status: ${status}. Must be one of: not-started, in-progress, completed`);
  }
  const data = readRaw();
  const maxId = data.todos.reduce((m, t) => Math.max(m, t.id || 0), 0);
  data.todos.push({ id: maxId + 1, status, title });
  data.ts = new Date().toISOString();
  writeRaw(data);
  return data;
}

function bulkUpdate(todos) {
  const data = readRaw();
  for (const update of todos) {
    if (update.status !== undefined && !VALID_STATUSES.has(update.status)) {
      throw new Error(`Invalid status: ${update.status}`);
    }
    const existing = data.todos.find((t) => t.id === update.id);
    if (existing) {
      if (update.status !== undefined) existing.status = update.status;
      if (update.title !== undefined) existing.title = update.title;
    }
  }
  data.ts = new Date().toISOString();
  writeRaw(data);
  return data;
}

function clearTodos() {
  const data = { ts: new Date().toISOString(), todos: [] };
  writeRaw(data);
  return data;
}

module.exports = { getTodos, updateTodo, createTodo, bulkUpdate, clearTodos };
