// Archived pre-port source/STL pairs; descriptions preserve historical reports, not current verification.
export type GalleryItem = {
  description: string;
  slug: string;
  source: string;
  stl: string;
  title: string;
};

export const galleryContent = {
  downloadLabel: "Download STL",
  empty: "Showcase pieces are on their way.",
  entries: [
    {
      description:
        "The pre-port five-pass run reported 38 rooms, 77 walls, 69 openings, 6 navigation features, and 5 furniture groups. It reported zero checker violations on a 2 × 2 board with a 400 × 400 mm assembled footprint.",
      slug: "fountain-hills-community-center",
      source: "/gallery/fountain-hills-source.png",
      stl: "/gallery/fountain-hills-map.stl",
      title: "Fountain Hills Community Center",
    },
    {
      description:
        "The pre-port five-pass run reported 9 rooms, 22 walls, 1 opening, and 8 navigation features. It reported zero checker violations on one 200 × 200 mm plate.",
      slug: "burke-museum",
      source: "/gallery/burke-museum-source.png",
      stl: "/gallery/burke-museum-map.stl",
      title: "Burke Museum · Second floor",
    },
    {
      description:
        "The pre-port five-pass run reported 20 rooms, 51 walls, and 7 openings for Buffalo's Downtown Central Library. It reported zero checker violations on a 1 × 2 board with a 200 × 400 mm assembled footprint.",
      slug: "buffalo-downtown-central-library",
      source: "/gallery/buffalo-library-source.png",
      stl: "/gallery/buffalo-library-map.stl",
      title: "Buffalo Downtown Central Library",
    },
    {
      description:
        "The pre-port Yonkers Riverfront Library run reported 14 rooms, 52 walls, 13 openings, and 9 navigation features. It reported zero checker violations on a 2 × 2 grid with a 400 × 400 mm assembled footprint.",
      slug: "yonkers-riverfront-library",
      source: "/gallery/yonkers-library-source.png",
      stl: "/gallery/yonkers-library-map.stl",
      title: "Yonkers Riverfront Library",
    },
    {
      description:
        "The pre-port CAA Ed Mirvish Theatre run reported 8 rooms, 31 walls, 11 openings, and 18 navigation or seating features. It reported zero checker violations on a 2 × 2 board with a 400 × 400 mm assembled footprint.",
      slug: "caa-ed-mirvish-theatre",
      source: "/gallery/ed-mirvish-source.png",
      stl: "/gallery/ed-mirvish-map.stl",
      title: "CAA Ed Mirvish Theatre · Orchestra floor",
    },
    {
      description:
        "The pre-port fourth-story library run reported 8 rooms, 56 walls, 12 openings, and 14 features or furniture groups. Its report recorded a 1 × 2 plate grid and 8 initial checker violations reduced to zero.",
      slug: "test-library-fourth-story",
      source: "/gallery/test-library-fourth-story-source.jpg",
      stl: "/gallery/test-library-fourth-story.stl",
      title: "Library · Fourth story",
    },
    {
      description:
        "The pre-port compact-library run reported 5 rooms, 13 walls, 4 openings, 4 navigation features, and 11 furniture groups. It reported zero checker violations on one 200 × 200 mm plate.",
      slug: "test-library-floor-plan",
      source: "/gallery/test-library-floor-plan-source.png",
      stl: "/gallery/test-library-floor-plan.stl",
      title: "Library floor plan",
    },
    {
      description:
        "The pre-port restroom run reported 10 rooms, 25 walls, 10 openings, 3 navigation features, and 3 fixture groups. It reported zero checker violations on one 200 × 200 mm plate.",
      slug: "test-public-restrooms",
      source: "/gallery/test-public-restrooms-source.png",
      stl: "/gallery/test-public-restrooms.stl",
      title: "Public restrooms",
    },
    {
      description:
        "The pre-port five-pass courtyard-museum run reported 9 rooms, 46 walls, 10 openings, 11 navigation features, and 1 furniture group. It reported zero checker violations on one 200 × 200 mm plate.",
      slug: "test-courtyard-museum",
      source: "/gallery/test-courtyard-museum-source.jpg",
      stl: "/gallery/test-courtyard-museum.stl",
      title: "Courtyard museum",
    },
    {
      description:
        "The pre-port museum run reported 17 rooms, 55 wall segments, 10 openings, and 9 navigation features. Its report recorded retained five-partition door gaps and the curved Hare Gallery boundary, with 29 tactile conflicts cleared on one plate; those source-fidelity claims are not newly verified here.",
      slug: "test-museum-floor-plan",
      source: "/gallery/test-museum-floor-plan-source.png",
      stl: "/gallery/test-museum-floor-plan.stl",
      title: "Museum floor plan",
    },
    {
      description:
        "The pre-port office run reported 5 rooms, 14 walls, 5 openings, 3 navigation features, and 3 furniture groups. It reported zero checker violations on one 200 × 200 mm plate.",
      slug: "office-plan",
      source: "/gallery/office-plan.png",
      stl: "/gallery/office-map.stl",
      title: "Office floor plan",
    },
  ] as readonly GalleryItem[],
  sourceLabel: "Uploaded plan",
  stlLabel: "Archived STL",
  title: "Gallery",
} as const;
