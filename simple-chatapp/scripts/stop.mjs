import { compose, readState } from "./support.mjs";
compose(["down", "--timeout", "10"], readState());
