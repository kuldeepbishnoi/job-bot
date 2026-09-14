import { render } from 'preact';
import '@/ui/theme.css';
import { App } from '@/ui/App';
import { initStore } from '@/ui/store';
import { startFlushing } from '@/ui/flush';

// The console is a normal extension page: same origin as the service worker, so it can read
// chrome.storage and IndexedDB directly. Data loads before the first paint so no view flashes
// an empty state it is about to replace.
void initStore().then(() => {
  startFlushing();
  render(<App />, document.getElementById('app')!);
});
