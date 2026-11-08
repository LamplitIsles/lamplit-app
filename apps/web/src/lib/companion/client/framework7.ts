import Framework7 from "framework7/lite";
import Framework7Svelte from "framework7-svelte";
import Accordion from "framework7/components/accordion";
import Messages from "framework7/components/messages";
import Messagebar from "framework7/components/messagebar";
import Input from "framework7/components/input";
import Actions from "framework7/components/actions";
import Popup from "framework7/components/popup";
import Popover from "framework7/components/popover";
import Panel from "framework7/components/panel";
import PhotoBrowser from "framework7/components/photo-browser";
import Searchbar from "framework7/components/searchbar";
import SmartSelect from "framework7/components/smart-select";
import Swiper from "framework7/components/swiper";
import Toast from "framework7/components/toast";
import VirtualList from "framework7/components/virtual-list";
import "./framework7.css";
Framework7.use([
  Accordion,
  Messages,
  Messagebar,
  Input,
  Actions,
  Popup,
  Popover,
  Panel,
  PhotoBrowser,
  Swiper,
  Searchbar,
  SmartSelect,
  Toast,
  VirtualList,
  Framework7Svelte,
]);
