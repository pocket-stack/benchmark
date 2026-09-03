// cases/list-create/main.tsx — Solid and Vue Vapor entry (Octane: main.octane.tsx).
import App, { bench } from "./app.tsx";
import { mount } from "@pocketjs/framework";

(globalThis as { __bench?: unknown }).__bench = bench;
mount(() => <App />);
