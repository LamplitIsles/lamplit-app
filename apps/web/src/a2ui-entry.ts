import { mount } from "svelte";
import "./lib/companion/client/framework7.ts";
import "./style.css";
import Embedded from "./lib/companion/a2ui/Embedded.svelte";
mount(Embedded, { target: document.getElementById("app")! });
