// Apply the saved colour theme before first paint (an external file: the CSP forbids inline scripts).
try { const t = localStorage.getItem('rico:theme'); if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; } catch { /* private mode */ }
