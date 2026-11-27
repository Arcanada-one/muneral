import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TaskDependencies } from '@/components/task/TaskDependencies';
import { PreferencesProvider } from '@/components/preferences/PreferencesProvider';
import type { MessageKey, PluralKey } from '@/lib/i18n/messages';
import { translate, translateEnum, translatePlural } from '@/lib/i18n/translate';
import { LOCALES } from '@/lib/preferences/preferences';

const state = vi.hoisted(() => ({ type: 'constructor' }));
vi.mock('@/lib/api/tasks', () => ({
  useDependencyGraph: () => ({
    data: [{
      id: 'dependency', type: state.type, direction: 'outgoing', fromTaskId: 'from', toTaskId: 'to',
      otherTaskId: '00000000-0000-4000-8000-000000000001', otherTaskTitle: 'Other task', otherTaskStatus: 'todo',
    }],
    isPending: false, isError: false, isFetching: false, refetch: vi.fn(),
  }),
}));

describe.each(LOCALES)('locale %s', (locale) => {
  it.each(['constructor', '__proto__', 'toString', 'a-new-type'])(
    'renders a dependency of unknown type "%s" with its raw name', (type) => {
      state.type = type;
      render(
        <PreferencesProvider initialLocale={locale} initialTheme="light">
          <TaskDependencies taskId="task" />
        </PreferencesProvider>,
      );
      expect(screen.getByText('Other task')).toBeTruthy();
      expect(screen.getByText(type)).toBeTruthy();
    });

  it('returns the English text for a key without an entry', () => {
    for (const key of ['No such message {count}', 'constructor', '__proto__', 'toString']) {
      expect(translate(locale, key as MessageKey)).toBe(key);
    }
    expect(translate(locale, 'No such message {count}' as MessageKey, { count: 2 })).toBe('No such message 2');
    expect(translateEnum(locale, 'constructor')).toBe('constructor');
    expect(translatePlural(locale, 'constructor' as PluralKey, 3)).toBe('constructor');
  });
});
