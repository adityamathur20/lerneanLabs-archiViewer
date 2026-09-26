import { test } from "node:test";
import assert from "node:assert/strict";
import { ifcToFrag, FRAG_MIN_BYTES } from "../src/ifc-to-frag.js";

/**
 * A minimal, valid IFC4 file with a full spatial tree and no building
 * elements at all — the shape of this corpus's two site-plan outliers, and of
 * any run whose wall detection found nothing.
 */
const EMPTY_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('empty.ifc','2026-09-26T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPERSON($,$,'',$,$,$,$,$);
#2=IFCORGANIZATION($,'',$,$,$);
#3=IFCPERSONANDORGANIZATION(#1,#2,$);
#4=IFCAPPLICATION(#2,'1','app','app');
#5=IFCOWNERHISTORY(#3,#4,$,.ADDED.,$,$,$,0);
#6=IFCDIRECTION((1.,0.,0.));
#7=IFCDIRECTION((0.,0.,1.));
#8=IFCCARTESIANPOINT((0.,0.,0.));
#9=IFCAXIS2PLACEMENT3D(#8,#7,#6);
#10=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#9,$);
#11=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#12=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);
#13=IFCUNITASSIGNMENT((#11,#12));
#14=IFCPROJECT('0YvctVUKr0kugbFTf53O9L',#5,'empty',$,$,$,$,(#10),#13);
#15=IFCSITE('1YvctVUKr0kugbFTf53O9L',#5,'Site',$,$,#9,$,$,.ELEMENT.,$,$,$,$,$);
#16=IFCBUILDING('2YvctVUKr0kugbFTf53O9L',#5,'Building',$,$,#9,$,$,.ELEMENT.,$,$,$);
#17=IFCBUILDINGSTOREY('3YvctVUKr0kugbFTf53O9L',#5,'Storey',$,$,#9,$,$,.ELEMENT.,0.);
#18=IFCRELAGGREGATES('4YvctVUKr0kugbFTf53O9L',#5,$,$,#14,(#15));
#19=IFCRELAGGREGATES('5YvctVUKr0kugbFTf53O9L',#5,$,$,#15,(#16));
#20=IFCRELAGGREGATES('6YvctVUKr0kugbFTf53O9L',#5,$,$,#16,(#17));
ENDSEC;
END-ISO-10303-21;
`;

test("converts an IFC with a spatial tree and no elements without throwing", async () => {
  const bytes = new TextEncoder().encode(EMPTY_IFC);
  const frag = await ifcToFrag(bytes);

  assert.ok(frag instanceof Uint8Array, "returns a buffer, not an exception");
  // A geometry-free model is legitimately small; the point is that it converts.
  assert.ok(frag.byteLength > 0, "produced a zero-length buffer");
});

test("FRAG_MIN_BYTES is the smoke threshold, not a correctness threshold", () => {
  // Documents the distinction the empty-model case exposes: `npm run smoke`
  // treats a tiny buffer as failure because it is pointed at real plans,
  // but a geometry-free IFC converting to a tiny buffer is correct.
  assert.ok(FRAG_MIN_BYTES > 0);
});
