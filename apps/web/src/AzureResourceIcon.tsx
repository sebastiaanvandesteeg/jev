/** Microsoft Cosmos DB Explorer assets, served locally. Attribution lives beside the SVGs. */
export function AzureResourceIcon({
  resource = 'cosmos-db',
  size = 18,
}: {
  resource?: 'cosmos-db' | 'database' | 'container';
  size?: number;
}) {
  return (
    <img
      className="azure-resource-icon"
      src={`/icons/azure/${resource}.svg`}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
    />
  );
}
