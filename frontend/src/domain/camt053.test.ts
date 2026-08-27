import { describe, expect, it } from 'vitest';
import { amountToCents, maskAccount, parseCamt053, parseXml } from './camt053';

/** A believable camt.053.001.02 statement, namespaced like the real ones. */
const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <BkToCstmrStmt>
    <GrpHdr><MsgId>STMT-2026-03</MsgId><CreDtTm>2026-04-01T04:10:00</CreDtTm></GrpHdr>
    <Stmt>
      <Id>stmt-1</Id>
      <Acct><Id><IBAN>CH9300762011623852957</IBAN></Id><Ccy>CHF</Ccy></Acct>
      <FrToDt><FrDtTm>2026-03-01T00:00:00</FrDtTm><ToDtTm>2026-03-31T23:59:59</ToDtTm></FrToDt>
      <Ntry>
        <Amt Ccy="CHF">1850.00</Amt>
        <CdtDbtInd>DBIT</CdtDbtInd>
        <Sts>BOOK</Sts>
        <BookgDt><Dt>2026-03-01</Dt></BookgDt>
        <ValDt><Dt>2026-03-01</Dt></ValDt>
        <BkTxCd><Domn><Cd>PMNT</Cd><Fmly><Cd>ICDT</Cd><SubFmlyCd>STDO</SubFmlyCd></Fmly></Domn></BkTxCd>
        <NtryDtls><TxDtls>
          <RltdPties><Cdtr><Nm>R&#233;gie du L&#233;man &amp; Cie</Nm></Cdtr></RltdPties>
          <RmtInf><Ustrd><![CDATA[Loyer mars 2026 <ref 4711>]]></Ustrd></RmtInf>
        </TxDtls></NtryDtls>
      </Ntry>
      <Ntry>
        <Amt Ccy="CHF">17.90</Amt>
        <CdtDbtInd>DBIT</CdtDbtInd>
        <Sts>BOOK</Sts>
        <BookgDt><Dt>2026-03-05</Dt></BookgDt>
        <BkTxCd><Domn><Cd>PMNT</Cd><Fmly><Cd>IDDT</Cd><SubFmlyCd>ESDD</SubFmlyCd></Fmly></Domn></BkTxCd>
        <NtryDtls><TxDtls>
          <RltdPties><Cdtr><Nm>Netflix International B.V.</Nm></Cdtr></RltdPties>
        </TxDtls></NtryDtls>
        <AddtlNtryInf>NETFLIX.COM 866-579-7172</AddtlNtryInf>
      </Ntry>
      <Ntry>
        <Amt Ccy="CHF">104.35</Amt>
        <CdtDbtInd>DBIT</CdtDbtInd>
        <Sts>BOOK</Sts>
        <BookgDt><Dt>2026-03-09</Dt></BookgDt>
        <BkTxCd><Domn><Cd>PMNT</Cd><Fmly><Cd>CCRD</Cd><SubFmlyCd>POSD</SubFmlyCd></Fmly></Domn></BkTxCd>
        <NtryDtls>
          <TxDtls>
            <AmtDtls><TxAmt><Amt Ccy="CHF">61.15</Amt></TxAmt></AmtDtls>
            <CdtDbtInd>DBIT</CdtDbtInd>
            <RltdPties><Cdtr><Nm>MIGROS M LAUSANNE</Nm></Cdtr></RltdPties>
          </TxDtls>
          <TxDtls>
            <AmtDtls><TxAmt><Amt Ccy="CHF">43.20</Amt></TxAmt></AmtDtls>
            <CdtDbtInd>DBIT</CdtDbtInd>
            <RltdPties><Cdtr><Nm>COOP-1077 RENENS</Nm></Cdtr></RltdPties>
          </TxDtls>
        </NtryDtls>
      </Ntry>
      <Ntry>
        <Amt Ccy="CHF">6500.00</Amt>
        <CdtDbtInd>CRDT</CdtDbtInd>
        <Sts>BOOK</Sts>
        <BookgDt><Dt>2026-03-25</Dt></BookgDt>
        <NtryDtls><TxDtls>
          <RltdPties><Dbtr><Nm>ACME SA</Nm></Dbtr></RltdPties>
          <RmtInf><Ustrd>Salaire mars</Ustrd></RmtInf>
        </TxDtls></NtryDtls>
      </Ntry>
      <Ntry>
        <Amt Ccy="EUR">12.00</Amt>
        <CdtDbtInd>DBIT</CdtDbtInd>
        <Sts>PDNG</Sts>
        <BookgDt><Dt>2026-03-31</Dt></BookgDt>
        <NtryDtls><TxDtls>
          <RltdPties><Cdtr><Nm>SNCF CONNECT</Nm></Cdtr></RltdPties>
        </TxDtls></NtryDtls>
      </Ntry>
      <Ntry>
        <Amt Ccy="CHF">43.20</Amt>
        <CdtDbtInd>CRDT</CdtDbtInd>
        <RvslInd>true</RvslInd>
        <Sts>BOOK</Sts>
        <BookgDt><Dt>2026-03-30</Dt></BookgDt>
      </Ntry>
    </Stmt>
  </BkToCstmrStmt>
</Document>`;

describe('parseCamt053', () => {
  const stmt = parseCamt053(SAMPLE)[0];

  it('reads the account masked — the full IBAN never leaves the parser', () => {
    expect(stmt.account).toBe('CH93 0076 … 2957');
    expect(stmt.account).not.toContain('2011623852957');
    expect(stmt.currency).toBe('CHF');
    expect(stmt.from).toBe('2026-03-01');
    expect(stmt.to).toBe('2026-03-31');
  });

  it('reads entries with exact cents, direction, dates and counterparties', () => {
    const rent = stmt.txs[0];
    expect(rent.amountCents).toBe(185000);
    expect(rent.debit).toBe(true);
    expect(rent.date).toBe('2026-03-01');
    // entity and CDATA decoding, straight from the hostile edges of XML
    expect(rent.party).toBe('Régie du Léman & Cie');
    expect(rent.info).toBe('Loyer mars 2026 <ref 4711>');
    expect(rent.method).toBe('transfer');
  });

  it('maps ISO bank transaction codes onto payment methods', () => {
    expect(stmt.txs.find((t) => t.party.startsWith('Netflix'))!.method).toBe('direct-debit');
    expect(stmt.txs.find((t) => t.party.startsWith('MIGROS'))!.method).toBe('card');
  });

  it('splits a batch booking into its card payments', () => {
    const migros = stmt.txs.find((t) => t.party.startsWith('MIGROS'))!;
    const coop = stmt.txs.find((t) => t.party.startsWith('COOP'))!;
    expect(migros.amountCents).toBe(6115);
    expect(coop.amountCents).toBe(4320);
    expect(migros.date).toBe('2026-03-09');
  });

  it('keeps credits, pending and reversals, marked as such', () => {
    const salary = stmt.txs.find((t) => t.party === 'ACME SA')!;
    expect(salary.debit).toBe(false);
    const sncf = stmt.txs.find((t) => t.party === 'SNCF CONNECT')!;
    expect(sncf.pending).toBe(true);
    expect(sncf.currency).toBe('EUR');
    expect(stmt.txs.some((t) => t.reversal)).toBe(true);
  });

  it('refuses anything that is not a camt statement', () => {
    expect(() => parseCamt053('<html><body>hi</body></html>')).toThrow(/ISO 20022/);
    expect(() => parseCamt053('<Document><SomethingElse/></Document>')).toThrow(/camt\.053/);
    expect(() => parseCamt053('not xml at all')).toThrow();
  });
});

describe('parseXml hardening', () => {
  it('refuses DTDs outright — no XXE, no entity expansion, ever', () => {
    const xxe = '<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><Document>&xxe;</Document>';
    expect(() => parseXml(xxe)).toThrow(/DTD/);
    const laughs = '<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;">]><Document>&lol2;</Document>';
    expect(() => parseXml(laughs)).toThrow(/DTD/);
  });

  it('refuses undefined entities and malformed structure', () => {
    expect(() => parseXml('<A>&nope;</A>')).toThrow(/entity/i);
    expect(() => parseXml('<A><B></A>')).toThrow();
    expect(() => parseXml('<A></A><B></B>')).toThrow(/one root/);
    expect(() => parseXml('<A>')).toThrow();
  });

  it('bounds nesting depth so a hostile file costs bounded work', () => {
    const deep = '<a>'.repeat(200) + '</a>'.repeat(200);
    expect(() => parseXml(deep)).toThrow(/deep/);
  });

  it('strips namespace prefixes and reads attributes', () => {
    const el = parseXml('<ns:Doc xmlns:ns="x"><ns:Amt Ccy="CHF">5</ns:Amt></ns:Doc>');
    expect(el.name).toBe('Doc');
    expect(el.children[0].name).toBe('Amt');
    expect(el.children[0].attrs.Ccy).toBe('CHF');
  });
});

describe('amountToCents', () => {
  it('is exact string maths, no floats', () => {
    expect(amountToCents('1850.00')).toBe(185000);
    expect(amountToCents('0.1')).toBe(10);
    expect(amountToCents('19.99')).toBe(1999);
    expect(amountToCents('1.005')).toBe(101);   // rounds half up on the 3rd decimal
    expect(amountToCents('7')).toBe(700);
  });
  it('refuses anything that is not a plain decimal', () => {
    expect(() => amountToCents('1,850.00')).toThrow();
    expect(() => amountToCents('-5')).toThrow();
    expect(() => amountToCents('1e3')).toThrow();
    expect(() => amountToCents('')).toThrow();
  });
});

describe('maskAccount', () => {
  it('keeps just enough to recognise the account', () => {
    expect(maskAccount('CH93 0076 2011 6238 5295 7')).toBe('CH93 0076 … 2957');
    expect(maskAccount('CH9300762011623852957')).toBe('CH93 0076 … 2957');
    expect(maskAccount('12345678')).toBe('12345678');
  });
});
