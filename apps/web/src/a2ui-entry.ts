import { mount } from "svelte";
import "./lib/companion/client/konsta.css";
import "./style.css";
import Embedded from "./lib/companion/a2ui/Embedded.svelte";
mount(Embedded, { target: document.getElementById("app")! });
