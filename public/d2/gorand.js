// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of Go's math/rand (the Go 1 "rngSource": an additive lagged-Fibonacci generator seeded with a
// Park-Miller LCG; BSD-3-Clause, Copyright 2009 The Go Authors). TALA (d2layouts/d2talalayout) builds its generators
// with rand.New(rand.NewSource(seed)) and draws Float64, Int63, Uint32 and Shuffle from them, so the value stream has
// to be bit exact. Seeds and Int63/Uint64 results are BigInt (int64/uint64 do not fit a double); Int31, Uint32, Intn,
// Int31n, Float64 and friends return numbers.
//
// The 607 words of rngCooked are Go's table (rng.go), stored as 16 hex digits each.

const rngLen = 607;
const rngTap = 273;
const int32max = 2147483647;

const COOKED_HEX =
  'c5f74a33eb98ffeac07b4a41ba965f5b135ec513cb81af0f4a04fb5ca74395eb' +
  'a7e8831c7710cf8e7d5de4e88f37c1c36321cf7743ff85a942cb06556a9ff961' +
  '6e26c8d140e8d7d249a7511f3411faa071ed774922a650559d5c9fc65fea2d5c' +
  '3fbdab394a01436870fa33596992340bae10fb4ecea66a02f79fbca98bbcd18a' +
  '97f7ccb12ea380ac0191d794caf32b1b3f6a323424e32cafc642cc921f01142b' +
  'a122869f4ff38068a5b1a31127af39205b07a4f9bdc29d966a2a973c29812586' +
  '6aa433dbf77a52e18394216e3b8ac99edb80a9c5515b997c03c3f2eff3cbf769' +
  'a6b5e431eeff210c0ec85334992953f52e6a1432df10d1e9bde4629959d1b149' +
  '67994c38763879510e15d461559bae63bdbf96c4e9d2a077b04f62866ada20f3' +
  '2190da1646db97bf5071873c1832957a3e3b503a19da904b33e388a5f2c78528' +
  'bec70bac19d0e87700256970f81bf072f7d18a14f64fa886a46ef978b4d4734c' +
  '782ff1573127a78e00241b0ad59beba6dac549591fe95b2f6195faf2884c2d39' +
  '569c2bbdb0ef345d0b8b6039508ce21eef1576705435d2bb1d5e900af5f1d8f7' +
  '1e902d187d7fd4377f227b7c8fe0eb7938790e6201ebbb9844818eac7922e171' +
  '0658d6c550dad34084bfb894cc72969aa7855141e3b329bd9cb31556b1bae746' +
  '3ca09004f9686f490c50146d7e508769cd35d8ff935ac970de9818b4aa1554d8' +
  '4df37efd6433daa0f591e9ad05b2e0561767eb0bdbf83e29b8247292535299f2' +
  'bae645975a5e4cebecea78155c3bc32b4e295e5357ace86e8b906a9a4fadbb08' +
  'fd50086af64463c9ad0385acfd19d6fcbbe6d4a5e1d13a9ffc099f33b79b039c' +
  'd9782224840c5a35174e38bc45d51acf53f82f9f54de4e3ee10dfa0a87b3ef0e' +
  'ea09d9ec7b439769519ec3c7cc4c50110b47990fc413e3d53f07e07ecfce5be2' +
  'a5d2d0b8b71922be451eea1fc87cc761c8505edef7f1d6ddfb6ed78e001ce905' +
  'd7cc0a3644f468ba14c231db2e4429d0e21ccd9a90943dd3664869f5288fc2d1' +
  'ddc56f604e168fb54151e4abb0b1faf6ec9647e8cea7b92776a742187dbe61de' +
  '80778d4049780e3c92714446c26ce41365475bc019e7700b0e08781d60d86d17' +
  '9f0f0fe9d5f571e0476e62bf33886e578c710cff524eb4e624e856a59e3899a5' +
  '549f7c8b5783189a9808539c06020014b8fc59eeb2515467f38fff8b8499a614' +
  'f5a62be73a3d5222508b82832b4c4838f5109fc7682ff8ded31cadf15cc53f0c' +
  'c1720509406b5826e900715210bc96fa0704fe3536d393fbc65c9b6eccaefb4a' +
  '8bafc73092be401907f0b599d77889ea18de0a49b8fa589b2f174e71c9830ff0' +
  'b470b780a26785dd20a6b76123b162be91efbd24cdc58322fb7bb75026b32623' +
  'd03d1caf9a1f04d0a5f0f909bcaee92146aa7ced9d1c8e0bfcd8a79e7a62b6f9' +
  '3ac4cf05bce83f1445c579a008a037c44053888e527912d0f88fa0b2289f7b17' +
  '51fbaf5d2002bdda8ae403a812ca47840d7ea237329fa450cb3f04bf02b6f208' +
  'c796643e8a39ed33fd92d79ed75b6419216821c8b258e8ace93d3aff7b46e931' +
  '36b0858cfcb72b6aae5e3c9fe7ff11672af4c395391cc2a5e6c4fd076feb7676' +
  '50efb5fb31ede7736d7f243359dbfcae7193e740340e0fdb8ff51f73a4c6dd92' +
  '94534b6efa1ca966c06a724520d70d4130cd16bd191205928d456b580c2cd6dc' +
  '5c62bc0d6a8429ef48744ea9b8e9395e18ef14825c84aee14a1e32b73a71e234' +
  '0fee6f27c45228c0464e2e3be0d2e4a123bb67f482e160080f11b541e8247327' +
  'ae7df90c7d2aafd754e1f496142c391a1d400ef625fa42749906966610ce9e13' +
  '22455934d7c1ccdae6414239b7da9220b49f9091f627555682916b3d64288abd' +
  '9f52d0a1c7066fa0642a666cfb8cf0a18c9d981db063ad8363dfa26158b67e4a' +
  'ce3cfe36ebecc2dfb6e4eb2ba55364ff6fd2179e0d7717d1b971a2b7362247db' +
  'dbe5cf25d510c53b930f28ad737352615a95dd01047feb8b30adb1407358b45a' +
  '7fb44776784c10831b20e8f4eb075406dc275f40b6c7c0d9732df8dda67b0f27' +
  'b62637afc484c88561c98649838bf631df061fee30277f5895d322052dac1455' +
  '7ad30486e478aee93267221f4aced145479807052c3566b8a8025350a77ea0b9' +
  '421a7ec2fc169cd357273ab05129a700bae4f7fb719f43f21c5bd857e8b8bf48' +
  'dad594186971f3593f518aad9c4270144c43c3b8cc8e8218981fba566f92dfb7' +
  '07acaac55435c0ac5fb0881038cbbc8ff243b5556cbeba7363149f303be79fd4' +
  'f6aade431f7124754cd2a557b6cbc24b21bc6975c169de72caf78cf40c768134' +
  'f13cdd624a12159fd573d0041b390d3e69ea8bd93bade806578baf3d78cd61f2' +
  '3318a93a7f689dc92da7501cbdbe52355b6d448c9bb11200036566ca66f231b4' +
  'b89e51e9e2b737e4704687541c9b68cf28df28a35d2937c98bfeb2756944b0b5' +
  '29c24143c2234e9cf4fd794f8d02068f0590f068df15e57de4ad98adab8dc009' +
  '4155b1828194a406ce463027d4ff743fd306231168ec0845ae01984986c0c339' +
  'cc61983656980e5ab6b4b212af3d051a70aaf14a706ce17a3547cbc995de3a40' +
  '6202b8d9e9e8565f8a49ea181ddbac3453a7bcb92853ce41a2aa132546a16f3a' +
  'd6c166634bc9286292ff6acebc93a0717a403280a96cea515a183b8f81665a24' +
  '222b4c80d2c0e464859e3d4d58ba3aa6b9a28389cb2fe56383a20cb89512fee4' +
  'cbd691b061b30cbd8839baf8f3ac9f095ddf03b3edd1c4b8f62694c4cb82ed09' +
  'd0c603b9879bd3608558daf780426657c87fdb1b629e32abd77938d516862fe1' +
  'e33a56962759ec00051bc82f174b90d9ab3b5debcad25c86a8766bd0dd9b35db' +
  '425f26b683ca14875d3c2b40a076f6537464e98a72f8d6342f02dd3eea4e7841' +
  '40977fe842527877fbf01ad4922b1d62ca959c2a8b4eea2969ca7ca110533802' +
  '6b36496357247bd97f7c07645ca7b232b8c63fa50ae3677ba0b7fd74703947d8' +
  '231fb1a0dc8ce07916b63342b7c96e77cd39a909d7e680271427685b19caecdd' +
  '9c9c6cd28e91b74d91c1fb790e0d3a547e67d3bdb81bb611d396fc0d89f6e211' +
  '457eacfbb049eb221de1979bf5654dd55d436ca7585d28cad3d7e2863218d979' +
  '2fa7be3ccf9d16451fb7a7e17b9eccb02b2b1fced929c282d85a90375e64310d' +
  'cb336a1611227dbd636925f5baf870cd43e0d0254b84715e080ec57577219247' +
  '175ee40f58fbd9713d78cc365badbce18495a076839032958f89c0d3396a3b53' +
  '639ba81c88d888a63faf8d9c775ca781eac40d3f519d289301fe31d8c7df7dc4' +
  '036d8003387dd6db8c0621f768220a9759d6a8cc7a0827072aea572af8467560' +
  '1c910136c9fdf9c3c73eddfe111385e279edb9a2a6a387dfd556d17adcc5f6fb' +
  'f72709f96b28a3c7552d69f0428dce6a9cbbb4be9a92c2164f37aef6caf41c5d' +
  'd3431110cdd7a9983c7c1de5b3cc1dca048311a7625eabd95ee41cb40ca81e2c' +
  '43385b68e51dbffcd36a1f70d4f9a2ffcaeaccb927b0cb5c3fddae4163e010e4' +
  '0e7f5452a8c91ee07e61315458970ccb8b821c0b10054c75c444cf11f9840608' +
  '2536b7a7602f6b4d331786d5a126f97fc9a9cd708372db93d7e75a07542451da' +
  'a4e5a10d286591049024ebcbf8b8e6af08137c3380f3252332a31118a95e425f' +
  'bd640b6140802b1e967e3cd0f12b1c5f031089e87fbab9a7f11bfbb3ba3e0841' +
  '3b7fc3ad0d1cd36bbfb2f4d968b759c34c8475564905d202e0a80b2a6236fa83' +
  '86a5b8671a833ae379608828eb8fe58d032bcb9f5721e71712d224e5dc7e16de' +
  '29e68b8251e0d4952bc04a7508cb08a385f835a648329d254d2799f797ec19a8' +
  '443aadc076f2ed1089357de277e46717af7907aeb63c9d6c27ce6be004db5b35' +
  '9bbf0228d95bf1d8ae31e17b25e1b36323e9429e957db925950e5fab3c7e6825' +
  '2aea3671bf9f5933b2d2ef433932102c0d7ed21ec77fc8c1ea5f1280f48e6247' +
  '17b747cdf311ae42e001060ea9fa838eaca7508c5bccfc84a3aaa0843f04f963' +
  'f949f7a4e8ebd3a522876bdefd41df6cc124724f07e69e7cbf470df23d5aa6b4' +
  '2998352099f590b811cc90f45895653d03550da1ab28f8d17842cc5c2b1b34db' +
  '08b79b3694ac8400bf72d50b84f96e2c947079f8eb08f590696cb72182050872' +
  'd4885bc9ac36d5a76cb888b579fe97e1629482105204e4fd3cef790816b93701' +
  'bda77a26be136556fb8f861314dda82808a2b7b803ae5bcfd3c8a91ed0323140' +
  '870001a0b867ec3ee4f6c1f9b093dde58e086becbc0b83789e755197c06ffcc7' +
  '246705ee34f204f8c7927582d516264cb3e17ba47546133ca33f111b5caab4e2' +
  'a23d8e161443255e48f128b344d0819c6cd122fb39ab204d5c2910bf238f36aa' +
  '90aeac10e05f9bba9d54b6b00fe42acae88f64387a0fcdcbc45a205f01473609' +
  'c768ed8eb6b8c82df225920d43fd23ac25bdad5a8a8179647ebc9cefb9015aab' +
  '3c1ee78fa4ea733de30e85d1757922a461123dc5e081fe21dc86c11079674e66' +
  '8918973fb91ab9fb00d4ee55ca6d8c2ad500476d5215b5b5fc5068b3e2ea6d2a' +
  '205da910dd23cb85979b5e11369f775b2bc872747d65ead796ba83aa2ac19de7' +
  'a2258710d3a06bd502bcfbd9169343e788eecd99246b6273234b301b2d3c0302' +
  '3c61095d0931ecbfc1fbeae253e444989bf8d56e39d28810ef025e3275852770' +
  '3b81d83bc6a5b26d740e3af17358a76b5a0491610c217837b234c04ee9707bba' +
  'e8d67481cf12c3243dc1a80712de14df9646cd056265e405c9ed5b85fe5de223' +
  'c034e6309514ca00a55cb1a9ea35e9bd83585dac1418cf4cc6bfe6b67ae71dfa' +
  'edde6a80958415988c478074a66108d349f4fb28492601c46c1f1e9a65e7acb8' +
  '44c3f220e0a3a35fc4422797ac160d7ea9bed55a11ad2c1529bdbe2cde52ac8d' +
  'a2486ed01638fb0c7be91fdd8fa250586d06c94a2118cf50be19f2b9fcb649e5' +
  '6da310d0ddefe7029db4d6197fe76870a1a8e96dd484eb63a2803dfd82f85916' +
  '3a1a0a44d7644c461a25188bb552aa62fa3eab18c620bd1133d24f4edd10ea99' +
  '386d39256536cc6c607e759efb2ba1e8921ebb3d7c6c607196ba6b088f86692f' +
  'b2bd2aeaeafed279b70cc2def3ab10ac2b1c1284b0b6db2bd7d4c4db5bbdff92' +
  '3f5b8190a0a0241e1b79f6457e60cfaea05c318c94181e913480a671b033e3d5' +
  '7579955efbbaa7552777c9f6d0c6b0d72a0f21c2f6662c43c286b4bc45869bbc' +
  '3de266b1c86ed2490596478ee80942c56fd3618b2ee6ae1b3f08073a3e5dea77' +
  '0e7847d01d6e71afcd1f81afc4fbaafe24be71c60778c9401dc2b6df046a9621' +
  'd0944e93950f6ccfe2c767041ea34007521bf9c9206576c6866b7a2bd7715e51' +
  '7a97753c8c79364152daac19784a65e407d3110b7c73f7eba66b273fbcc429b7' +
  '16302dc85a75540ac840d3700a56e4ded6875303fcd05bffabbeed06a5e32588' +
  '758a6526f8636a3a01be7adae8e62038c9b4bec75bc4f40adc7a69ce0a9fc1c3' +
  'f93f853c0adbaa64be48b8658e39d5b65233cc88f307cb8581f48c566746e404' +
  'e6e72b2f3e1111926ee3ad5d7b4333d53bebf80abf44e35e324f3dfa2996372c' +
  'a60900d584d3294fcfb39707d3e017c8d33cd1090a56f237fae17ac7e5605d43' +
  'c8c0106f0ead441989bba8037b2a60be6999983c12a6557d29ecb289d4fc6351' +
  'dc4e3ec308888d222492188c7c1156a7476502781cf85a108e5d5db3b1c10b44' +
  '15bff6623ba91eb7716a28bba3f09c65d7f47607c92f30f19e04907834879dad' +
  'a611c59795db70999a74c74315758aa3536d4c40116f323952539ac587ad97d0' +
  '1f1a1675f28959c38c6d78f5619e83242af1cfe563eff7ad3f9d2212e5c94b1d' +
  '7e023d467b37b61ffaab76adabeee96bcff95dd9926b62d13aa278a62172db76' +
  '9982abe519c8c86734c2118df1f5857efa7376b640136c8098a7d04ca29ade2f' +
  '6d9f14b04d77e77e4b3dad048bed47a14c9ee5e4931d3231baf4eba543f33d0a' +
  '793aafa07373d926986ea60fe6b39a32e31f344f666361e6f21cbedc44c049cb' +
  'c4f752a0eb5e5403af1b99e27d410520592740a0e5b8c3dd04fc4ea5fb446c97' +
  'ad6e587f47afe7a6de542c137b8384a42a0ffc0f7b301e5c820547300a5d8af4' +
  'd3c639c2087dc0790a467ca8709a2bb6e242bb6bb4da36de6079b0531ec90376' +
  '058ccf98dc1843f78417b417b011aec1ecdedd4ff0dd641b8c3787282349e832' +
  'd5f0bb8816e7e8fb85b650480fd8c2f47d45aa734f760b6d5962428553d20814' +
  '400e2ba01968e7c4077e19b9a3f760001d17558f6164030c79753148c0e6c59f' +
  '9a77d2f2ef3bd843666eb88d8701e16f5572e7ce34288668eb8d82b15491d607' +
  '77c265a71aebbe544947dddd6f3e9e07628dfe635c79558622673e39d43ff99b' +
  '637e086dc78cf522ee37e3669f7e9c6692d7bb47a4afe8381f9eabdfdbe2b7bd' +
  '324fca6af2b5c1d159e4a152525b1b297c91d10a8d75740ecc7c533a7fca95d8' +
  '1266fbf77386b1db689a66ba46d1c3bd4bd671b124b5701a2c43fd0a9eaec04d' +
  '58143117e4e165558358c5bb1248ac23aaf677bd80e30ac5fc997227a4f07f8f' +
  'a848cc5d9cb0e150640a711eb0e49b4164fcbfa01dca3978980aab2fff6bc784' +
  '395c6750aa42e65e287fea4c9695f3f49516361749f6428ac977d592999f2194' +
  'c45166d9f6935ff8a7f503a28f431ca951d3a3c351be10ecf579e080162896e9' +
  'e5b5e9385b202824fbba1e4a59b0c60ca8de655829aab207e1de048dc78b382e' +
  '74535a96cc7adfd77e57a19b735ef03b39a00a3a31c025c6';

// rngCooked as (hi, lo) uint32 pairs.
const cookedHi = new Uint32Array(rngLen);
const cookedLo = new Uint32Array(rngLen);
for (let i = 0; i < rngLen; i++) {
  cookedHi[i] = parseInt(COOKED_HEX.slice(i * 16, i * 16 + 8), 16);
  cookedLo[i] = parseInt(COOKED_HEX.slice(i * 16 + 8, i * 16 + 16), 16);
}

// seedrand: x[n+1] = 48271 * x[n] mod (2**31 - 1) (int32 arithmetic; no intermediate overflows).
function seedrand(x) {
  const A = 48271, Q = 44488, R = 3399;
  const hi = Math.trunc(x / Q);
  const lo = x % Q;
  x = A * lo - R * hi;
  if (x < 0) x += int32max;
  return x;
}

/** Go's rngSource. */
export class RngSource {
  constructor(seed) {
    this.tap = 0;
    this.feed = 0;
    this.hi = new Uint32Array(rngLen);
    this.lo = new Uint32Array(rngLen);
    this._h = 0; // result of the last _next(): uint64 as (hi, lo)
    this._l = 0;
    this.seed(seed);
  }

  /** Seed(seed int64): seed is a BigInt or an integer number. */
  seed(seed) {
    this.tap = 0;
    this.feed = rngLen - rngTap;
    let s = BigInt(seed) % 2147483647n; // Go's % keeps the sign of the dividend, like BigInt's
    if (s < 0n) s += 2147483647n;
    if (s === 0n) s = 89482311n;
    let x = Number(s);
    for (let i = -20; i < rngLen; i++) {
      x = seedrand(x);
      if (i >= 0) {
        // u = int64(x)<<40; x = seedrand(x); u ^= int64(x)<<20; x = seedrand(x); u ^= int64(x); u ^= rngCooked[i]
        let h = (x << 8) >>> 0;
        let l = 0;
        x = seedrand(x);
        h = (h ^ (x >>> 12)) >>> 0;
        l = (l ^ ((x << 20) >>> 0)) >>> 0;
        x = seedrand(x);
        l = (l ^ x) >>> 0;
        h = (h ^ cookedHi[i]) >>> 0;
        l = (l ^ cookedLo[i]) >>> 0;
        this.hi[i] = h;
        this.lo[i] = l;
      }
    }
  }

  // Uint64: advances the register and leaves the result in this._h/this._l.
  _next() {
    this.tap--;
    if (this.tap < 0) this.tap += rngLen;
    this.feed--;
    if (this.feed < 0) this.feed += rngLen;
    const sl = this.lo[this.feed] + this.lo[this.tap];
    const carry = sl > 0xffffffff ? 1 : 0;
    const l = sl >>> 0;
    const h = (this.hi[this.feed] + this.hi[this.tap] + carry) >>> 0;
    this.hi[this.feed] = h;
    this.lo[this.feed] = l;
    this._h = h;
    this._l = l;
  }

  /** Uint64() as a BigInt. */
  uint64() {
    this._next();
    return (BigInt(this._h) << 32n) | BigInt(this._l);
  }

  /** Int63() as a BigInt. */
  int63() {
    this._next();
    return (BigInt(this._h & 0x7fffffff) << 32n) | BigInt(this._l);
  }
}

/** rand.NewSource(seed). */
export function newSource(seed) {
  return new RngSource(seed);
}

/** *rand.Rand over an rngSource. */
export class Rand {
  constructor(src) {
    this.src = src;
  }

  /** Int63() as a BigInt. */
  int63() {
    return this.src.int63();
  }

  /** Uint32(): uint32(Int63() >> 31). */
  uint32() {
    this.src._next();
    return (this.src._h & 0x7fffffff) * 2 + (this.src._l >>> 31);
  }

  /** Uint64() as a BigInt. */
  uint64() {
    return this.src.uint64();
  }

  /** Int31(): int32(Int63() >> 32). */
  int31() {
    this.src._next();
    return this.src._h & 0x7fffffff;
  }

  /** Int() as a BigInt (Go int is 64 bits on amd64 and wasm). */
  int() {
    return this.src.int63();
  }

  /** Int63n(n) with n a BigInt > 0; returns a BigInt. */
  int63n(n) {
    n = BigInt(n);
    if (n <= 0n) throw new Error('invalid argument to Int63n');
    if ((n & (n - 1n)) === 0n) return this.int63() & (n - 1n);
    const max = (1n << 63n) - 1n - ((1n << 63n) % n);
    let v = this.int63();
    while (v > max) v = this.int63();
    return v % n;
  }

  /** Int31n(n), n an int32 > 0. */
  int31n(n) {
    if (n <= 0) throw new Error('invalid argument to Int31n');
    if ((n & (n - 1)) === 0) return this.int31() & (n - 1);
    const max = 2147483647 - (2147483648 % n);
    let v = this.int31();
    while (v > max) v = this.int31();
    return v % n;
  }

  // int31n (lower case in Go): Lemire's reduction, used by Shuffle.
  _int31n(n) {
    let v = this.uint32();
    let prod = BigInt(v) * BigInt(n);
    let low = Number(prod & 0xffffffffn);
    if (low < n) {
      const thresh = (4294967296 - n) % n; // uint32(-n) % uint32(n)
      while (low < thresh) {
        v = this.uint32();
        prod = BigInt(v) * BigInt(n);
        low = Number(prod & 0xffffffffn);
      }
    }
    return Number(prod >> 32n);
  }

  /** Intn(n) for 0 < n <= 2^53 as a number. */
  intn(n) {
    if (n <= 0) throw new Error('invalid argument to Intn');
    if (n <= 2147483647) return this.int31n(n);
    return Number(this.int63n(BigInt(n)));
  }

  /** Float64() in [0, 1). */
  float64() {
    for (;;) {
      this.src._next();
      // float64(int64) rounds to nearest even: hi31 * 2^32 is exact and the sum with lo rounds once.
      const f = ((this.src._h & 0x7fffffff) * 4294967296 + this.src._l) / 9223372036854775808;
      if (f !== 1) return f;
    }
  }

  /** Float32() in [0, 1). */
  float32() {
    for (;;) {
      const f = Math.fround(this.float64());
      if (f !== 1) return f;
    }
  }

  /** Perm(n): a random permutation of 0..n-1. */
  perm(n) {
    const m = new Array(n);
    for (let i = 0; i < n; i++) {
      const j = this.intn(i + 1);
      m[i] = m[j];
      m[j] = i;
    }
    return m;
  }

  /** Shuffle(n, swap): Fisher-Yates with Lemire's int31n. */
  shuffle(n, swap) {
    if (n < 0) throw new Error('invalid argument to Shuffle');
    let i = n - 1;
    for (; i > 2147483646; i--) {
      const j = Number(this.int63n(BigInt(i + 1)));
      swap(i, j);
    }
    for (; i > 0; i--) {
      const j = this._int31n(i + 1);
      swap(i, j);
    }
  }
}

/** rand.New(rand.NewSource(seed)). */
export function newRand(seed) {
  return new Rand(new RngSource(seed));
}
