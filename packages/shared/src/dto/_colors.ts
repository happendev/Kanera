import { z } from "zod";
import { COLOR_TOKENS, GRADIENT_TOKENS } from "../lib/colors.js";

export const colorTokenSchema = z.enum(COLOR_TOKENS);
export const gradientTokenSchema = z.enum(GRADIENT_TOKENS);
