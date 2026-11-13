// فانسي سنس — Service Worker بسيط: يجعل البرنامج قابلاً للتثبيت كتطبيق، بدون تخزين مؤقت (دائماً أحدث نسخة من الإنترنت)
self.addEventListener('install',e=>self.skipWaiting());
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('fetch',e=>{});
