"""Bounded, non-executing interpretation of explicit per-file Python search paths.

Only top-level Path(__file__).resolve(), parent/parents[N], literal `/` joins,
name assignments and sys.path.insert(0, str(path)) are admitted. Unknown path
mutations suppress absolute resolution rather than choosing a guessed provider.
Paths refer to Git tree names; no host filesystem or module is imported.
"""
from __future__ import annotations

import ast
import posixpath


def import_roots(text: str, file: str) -> tuple[dict[int, list[str] | None], list[str]]:
    try:
        tree = ast.parse(text)
    except (SyntaxError, RecursionError):
        return {}, []  # Existing lexical extraction still handles otherwise parseable constructs.
    names: dict[str, tuple[str, str]] = {}
    roots: list[str] = []
    blocked = False
    by_line: dict[int, list[str] | None] = {}
    limitations: list[str] = []

    def value(node):
        if isinstance(node, ast.Name):
            return ('path', '/repo/' + file) if node.id == '__file__' and node.id not in names else names.get(node.id)
        if isinstance(node, ast.Call) and not node.keywords:
            if isinstance(node.func, ast.Name) and names.get(node.func.id) == ('alias', 'Path') and len(node.args) == 1:
                v = value(node.args[0])
                return v if v and v[0] == 'path' else None
            if isinstance(node.func, ast.Name) and node.func.id == 'str' and 'str' not in names and len(node.args) == 1:
                return value(node.args[0])
            if isinstance(node.func, ast.Attribute) and node.func.attr == 'resolve' and not node.args:
                return value(node.func.value)
        if isinstance(node, ast.Attribute) and node.attr == 'parent':
            v = value(node.value)
            return ('path', posixpath.dirname(v[1])) if v and v[0] == 'path' else None
        if (isinstance(node, ast.Subscript) and isinstance(node.value, ast.Attribute)
                and node.value.attr == 'parents' and isinstance(node.slice, ast.Constant)
                and type(node.slice.value) is int and 0 <= node.slice.value <= 32):
            v = value(node.value.value)
            if v and v[0] == 'path':
                p = v[1]
                for _ in range(node.slice.value + 1):
                    p = posixpath.dirname(p)
                return ('path', p)
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Div):
            v = value(node.left)
            if v and v[0] == 'path' and isinstance(node.right, ast.Constant) and isinstance(node.right.value, str):
                s = node.right.value
                if s and not s.startswith('/') and '\\' not in s and '..' not in s.split('/'):
                    return ('path', posixpath.normpath(v[1] + '/' + s))
        return None

    def sys_path(node):
        return (isinstance(node, ast.Attribute) and node.attr == 'path'
                and isinstance(node.value, ast.Name) and names.get(node.value.id) == ('alias', 'sys'))

    for stmt in tree.body:
        mutations = [n for n in ast.walk(stmt) if sys_path(n)]
        if mutations:
            call = stmt.value if isinstance(stmt, ast.Expr) and isinstance(stmt.value, ast.Call) else None
            exact = (call and isinstance(call.func, ast.Attribute) and sys_path(call.func.value)
                     and call.func.attr == 'insert' and not call.keywords and len(call.args) == 2
                     and isinstance(call.args[0], ast.Constant) and type(call.args[0].value) is int
                     and call.args[0].value == 0)
            v = value(call.args[1]) if exact else None
            if v and v[0] == 'path' and (v[1] == '/repo' or v[1].startswith('/repo/')) and not blocked:
                roots.insert(0, v[1][len('/repo'):].lstrip('/'))
            else:
                blocked = True
                limitations.append(f'python: unresolved sys.path mutation at {file}:{stmt.lineno}; absolute imports not resolved')
        for node in ast.walk(stmt):
            if isinstance(node, (ast.Import, ast.ImportFrom)):
                by_line[node.lineno] = None if blocked else list(roots)
        if isinstance(stmt, ast.Import):
            for alias in stmt.names:
                names[alias.asname or alias.name.split('.')[0]] = ('alias', 'sys') if alias.name == 'sys' else ('unknown', '')
        elif isinstance(stmt, ast.ImportFrom):
            for alias in stmt.names:
                names[alias.asname or alias.name] = ('alias', 'Path') if stmt.module == 'pathlib' and alias.name == 'Path' and not stmt.level else ('unknown', '')
        elif isinstance(stmt, (ast.Assign, ast.AnnAssign, ast.AugAssign)):
            v = value(stmt.value) if not isinstance(stmt, ast.AugAssign) else None
            targets = stmt.targets if isinstance(stmt, ast.Assign) else [stmt.target]
            for target in targets:
                for node in ast.walk(target):
                    if isinstance(node, ast.Name):
                        names[node.id] = v or ('unknown', '')
        elif isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names[stmt.name] = ('unknown', '')
        else:
            # Conditional assignments/imports cannot establish a deterministic anchor.
            for node in ast.walk(stmt):
                if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store):
                    names[node.id] = ('unknown', '')
                elif isinstance(node, (ast.Import, ast.ImportFrom)):
                    for alias in node.names:
                        names[alias.asname or alias.name.split('.')[0]] = ('unknown', '')
    return by_line, limitations
