import { render } from 'preact';
import '@/ui/theme.css';
import './popup.css';
import { Popup } from '@/ui/Popup';
import { initStore } from '@/ui/store';
import { startFlushing } from '@/ui/flush';

// Same components and same signals as the console — the popup is just the small surface.
void initStore().then(() => {
  startFlushing();
  render(<Popup />, document.getElementById('app')!);
});
