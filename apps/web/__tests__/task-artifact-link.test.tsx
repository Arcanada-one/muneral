import '@testing-library/jest-dom/vitest';
import {cleanup, render, screen} from '@testing-library/react';
import {afterEach, expect, it} from 'vitest';
import {TaskTranscription} from '@/components/task/TaskTranscription';
import {readTask} from '@/lib/api/read-contract';
const jobId = '11111111-1111-4111-8111-111111111111';
const producerRoute = 'https://example.invalid/v1/jobs/' + jobId + '/result?format=txt';
afterEach(cleanup);
it('renders the exact current producer route and labels R2 as unmeasured', () => {
  render(<TaskTranscription link={{jobId, producerRoute}} />);
  const link = screen.getByRole('link', {name: 'Open transcription'});
  expect(link).toHaveAttribute('href', producerRoute);
  expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  expect(screen.getByText(/Production R2 not measured/)).toBeInTheDocument();
});
it.each(['javascript:alert(1)', 'r2://synthetic/job', producerRoute.replace(jobId, '22222222-2222-4222-8222-222222222222'), producerRoute + '&token=synthetic', producerRoute.replace('format=txt', 'format=html')])('refuses unsafe or wrong-job route %s', route => {
  render(<TaskTranscription link={{jobId, producerRoute: route}} />);
  expect(screen.getByRole('alert')).toBeInTheDocument();
  expect(screen.queryByRole('link')).not.toBeInTheDocument();
});
it('ordinary tasks have no transcription link', () => {
  render(<TaskTranscription />); expect(screen.queryByRole('link')).not.toBeInTheDocument();
});
it('task read retains and validates the native transcription descriptor', () => {
  const task={id: jobId, projectId: jobId, title: 'Synthetic', status: 'todo', priority: 'medium', actorType: 'human', createdAt: '2026-10-08T00:00:00Z', updatedAt: '2026-10-08T00:00:00Z', transcriptionLink: {jobId, producerRoute}};
  expect(readTask(task).transcriptionLink).toEqual({jobId, producerRoute});
  expect(() => readTask({...task, transcriptionLink: {...task.transcriptionLink, jobId: '22222222-2222-4222-8222-222222222222'}})).toThrow();
});

it.each(['https:example.invalid', 'https:/example.invalid', 'https:///example.invalid', 'https:\\example.invalid', 'https://example.invalid\\v1'])('refuses browser-base ambiguous producer authority %s', authority => {
  render(<TaskTranscription link={{jobId, producerRoute: authority + '/v1/jobs/' + jobId + '/result?format=txt'}} />);
  expect(screen.getByRole('alert')).toBeInTheDocument();
  expect(screen.queryByRole('link')).not.toBeInTheDocument();
  const task={id:jobId,projectId:jobId,title:'Synthetic',status:'todo',priority:'medium',actorType:'human',createdAt:'2026-10-08T00:00:00Z',updatedAt:'2026-10-08T00:00:00Z',transcriptionLink:{jobId,producerRoute:authority+'/v1/jobs/'+jobId+'/result?format=txt'}};
  expect(() => readTask(task)).toThrow();
});
