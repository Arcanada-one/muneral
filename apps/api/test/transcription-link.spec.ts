import {readTranscriptionLink} from '../src/tasks/dto/transcription-link.dto.js';
const jobId='11111111-1111-4111-8111-111111111111';
const route='https://example.invalid/v1/jobs/'+jobId+'/result?format=txt';
describe('transcription producer route authority', () => {
  it.each(['https:example.invalid', 'https:/example.invalid', 'https:///example.invalid', 'https:\\example.invalid', 'https://example.invalid\\v1'])('rejects ambiguous authority %s', authority => {
    expect(() => readTranscriptionLink({jobId,producerRoute: authority+'/v1/jobs/'+jobId+'/result?format=txt'})).toThrow();
  });
  it.each(['txt','srt','vtt','json'])('preserves accepted absolute HTTPS bytes for %s', format => {
    const producerRoute=route.replace('format=txt','format='+format);
    expect(readTranscriptionLink({jobId,producerRoute})).toEqual({jobId,producerRoute});
  });
});
