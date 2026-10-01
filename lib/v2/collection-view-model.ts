import type { DemoCollection } from "../demo-data.ts";
import type { CollectionSummary } from "./repositories/collections-core.ts";
import { collectionBanner } from "../vaultshuffle-assets.ts";

export function collectionModel(collection:CollectionSummary):DemoCollection {
  return {id:collection.publicId,kind:collection.kind,name:collection.name,description:collection.description??"",
    smartPreset:collection.rules?.preset,artworkUrl:collectionBanner(collection.name,collection.rules?.preset)??"/assets/vault/vault-stage-open.png",
    accent:`${collection.count} games currently assigned.`,count:collection.count,preview:[...collection.preview]};
}
