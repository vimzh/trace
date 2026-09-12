import { siteContent } from "./site";

export const landingContent = {
  hero: {
    brand: siteContent.title,
    subheading:
      "Create tactile maps from floor plans for blind and low-vision visitors.",
    tagline:
      "No custom commissions. Upload a floor plan and print it for about $1 in filament.",
    upload: {
      failed: "Upload failed. Try again.",
      guideHref: "/input-guide",
      guideLabel: "Good and bad floor-plan examples",
      hint: "PDF, PNG, JPG, or WebP · up to 10 MB",
      label: "Upload floor plan",
      tooLarge: "That file is over 10 MB. Try a smaller export.",
      uploading: "Uploading…",
    },
    compliance: {
      lead: "Implemented geometry checks are informed by",
      standards: [
        {
          name: "BANA 2022",
          fullName:
            "Guidelines and Standards for Tactile Graphics (2022), Braille Authority of North America",
          href: "https://www.brailleauthority.org/tg/",
        },
        {
          name: "ADA §703",
          fullName:
            "ADA Standards for Accessible Design §703 — braille and tactile signage",
          href: "https://www.access-board.gov/ada/guides/chapter-7-signs/",
        },
      ],
    },
  },
  footer: {
    poweredBy: "powered by Strands Agents SDK",
  },
} as const;
