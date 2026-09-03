// cases/reactive-single/main.octane.tsx — Octane entry: mount() takes the component itself.
import App, { bench } from "./app.tsx";
import { mount } from "@pocketjs/framework";

(globalThis as { __bench?: unknown }).__bench = bench;
mount(App);
