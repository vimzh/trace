import type { Metadata } from "next";
import { Manrope } from "next/font/google";
import { PitchDeck } from "@/components/pitch/pitch-deck";
import { pitchMetadata } from "@/data/pitch";

const manrope = Manrope({
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = pitchMetadata;

export default function PitchPage() {
  return <PitchDeck fontClassName={manrope.className} />;
}
