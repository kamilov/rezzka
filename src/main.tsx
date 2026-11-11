import { createRoot } from 'react-dom/client';
import { init } from '@noriginmedia/norigin-spatial-navigation';
import App from './App';
import './styles.css';

init({ debug: false, visualDebug: false, shouldFocusDOMNode: true, domNodeFocusOptions: { preventScroll: true } });
createRoot(document.getElementById('root')!).render(<App />);
