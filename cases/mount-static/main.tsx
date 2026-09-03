// cases/mount-static/main.tsx — Solid and Vue Vapor entry (Octane: main.octane.tsx).
// Installs the case protocol object before mounting so the host finds it at eval.
import App, { bench } from "./app.tsx";
import { mount } from "@pocketjs/framework";

(globalThis as { __bench?: unknown }).__bench = bench;
mount(() => <App />);
