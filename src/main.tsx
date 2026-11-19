import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import './game-skin.css';
import './game-hud.css';
import './game-interactions.css';
import './trade-layout.css';

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
