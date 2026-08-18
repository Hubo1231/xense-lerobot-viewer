import React from "react";

/**
 * Interpolate React nodes into a message template.
 *
 * Plenty of our sentences wrap one substitution in its own markup — a mono path,
 * an amber count, a coloured tag word. Splitting those into `…Before` / `…After`
 * key pairs would freeze English word order, which is exactly what breaks when
 * the same sentence is written in Chinese. Keeping the whole sentence as one
 * translatable string with `{name}` slots lets each language put the styled
 * fragment wherever it belongs.
 *
 * Unknown placeholders are left verbatim, matching `interpolate`.
 */
export function richInterpolate(
  template: string,
  vars: Record<string, React.ReactNode>,
): React.ReactNode {
  const parts = template.split(/(\{\w+\})/g);
  return (
    <>
      {parts.map((part, i) => {
        const match = /^\{(\w+)\}$/.exec(part);
        if (!match) return part;
        const value = vars[match[1]];
        return value === undefined ? (
          part
        ) : (
          <React.Fragment key={i}>{value}</React.Fragment>
        );
      })}
    </>
  );
}
