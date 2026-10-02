//! The runtime helpers module conversion emits, verbatim from esbuild 0.24.2
//! (MIT, Copyright (c) 2020 Evan Wallace), in the order esbuild prints them.
//! Their names are part of the contract: Nimbus's server-launch analysis
//! recognizes `__toESM(require(...))` and `__toCommonJS(...)` by name.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u16)]
pub enum Helper {
    Create = 1 << 0,
    DefProp = 1 << 1,
    GetOwnPropDesc = 1 << 2,
    GetOwnPropNames = 1 << 3,
    GetProtoOf = 1 << 4,
    HasOwnProp = 1 << 5,
    CommonJs = 1 << 6,
    Export = 1 << 7,
    CopyProps = 1 << 8,
    ReExport = 1 << 9,
    ToEsm = 1 << 10,
    ToCommonJs = 1 << 11,
}

const ALL: [Helper; 12] = [
    Helper::Create,
    Helper::DefProp,
    Helper::GetOwnPropDesc,
    Helper::GetOwnPropNames,
    Helper::GetProtoOf,
    Helper::HasOwnProp,
    Helper::CommonJs,
    Helper::Export,
    Helper::CopyProps,
    Helper::ReExport,
    Helper::ToEsm,
    Helper::ToCommonJs,
];

impl Helper {
    pub fn name(self) -> &'static str {
        match self {
            Self::Create => "__create",
            Self::DefProp => "__defProp",
            Self::GetOwnPropDesc => "__getOwnPropDesc",
            Self::GetOwnPropNames => "__getOwnPropNames",
            Self::GetProtoOf => "__getProtoOf",
            Self::HasOwnProp => "__hasOwnProp",
            Self::CommonJs => "__commonJS",
            Self::Export => "__export",
            Self::CopyProps => "__copyProps",
            Self::ReExport => "__reExport",
            Self::ToEsm => "__toESM",
            Self::ToCommonJs => "__toCommonJS",
        }
    }

    fn source(self) -> &'static str {
        match self {
            Self::Create => "var __create = Object.create;\n",
            Self::DefProp => "var __defProp = Object.defineProperty;\n",
            Self::GetOwnPropDesc => "var __getOwnPropDesc = Object.getOwnPropertyDescriptor;\n",
            Self::GetOwnPropNames => "var __getOwnPropNames = Object.getOwnPropertyNames;\n",
            Self::GetProtoOf => "var __getProtoOf = Object.getPrototypeOf;\n",
            Self::HasOwnProp => "var __hasOwnProp = Object.prototype.hasOwnProperty;\n",
            Self::CommonJs => concat!(
                "var __commonJS = (cb, mod) => function __require() {\n",
                "  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;\n",
                "};\n",
            ),
            Self::Export => concat!(
                "var __export = (target, all) => {\n",
                "  for (var name in all)\n",
                "    __defProp(target, name, { get: all[name], enumerable: true });\n",
                "};\n",
            ),
            Self::CopyProps => concat!(
                "var __copyProps = (to, from, except, desc) => {\n",
                "  if (from && typeof from === \"object\" || typeof from === \"function\") {\n",
                "    for (let key of __getOwnPropNames(from))\n",
                "      if (!__hasOwnProp.call(to, key) && key !== except)\n",
                "        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });\n",
                "  }\n",
                "  return to;\n",
                "};\n",
            ),
            Self::ReExport => "var __reExport = (target, mod, secondTarget) => (__copyProps(target, mod, \"default\"), secondTarget && __copyProps(secondTarget, mod, \"default\"));\n",
            Self::ToEsm => concat!(
                "var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(\n",
                "  isNodeMode || !mod || !mod.__esModule ? __defProp(target, \"default\", { value: mod, enumerable: true }) : target,\n",
                "  mod\n",
                "));\n",
            ),
            Self::ToCommonJs => "var __toCommonJS = (mod) => __copyProps(__defProp({}, \"__esModule\", { value: true }), mod);\n",
        }
    }

    fn requires(self) -> u16 {
        use Helper::*;
        match self {
            CommonJs => GetOwnPropNames as u16,
            Export => DefProp as u16,
            CopyProps => DefProp as u16 | GetOwnPropNames as u16 | HasOwnProp as u16 | GetOwnPropDesc as u16,
            ReExport => CopyProps as u16,
            ToEsm => Create as u16 | GetProtoOf as u16 | DefProp as u16 | CopyProps as u16,
            ToCommonJs => CopyProps as u16 | DefProp as u16,
            _ => 0,
        }
    }
}

/// A set of helpers, closed over what each one calls.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Helpers(u16);

impl Helpers {
    pub fn add(&mut self, helper: Helper) {
        if self.0 & helper as u16 != 0 {
            return;
        }
        self.0 |= helper as u16;
        for dependency in ALL {
            if helper.requires() & dependency as u16 != 0 {
                self.add(dependency);
            }
        }
    }

    pub fn is_empty(self) -> bool {
        self.0 == 0
    }

    pub fn iter(self) -> impl Iterator<Item = Helper> {
        ALL.into_iter().filter(move |h| self.0 & *h as u16 != 0)
    }

    /// The helpers' source, in esbuild's order.
    pub fn source(self) -> String {
        self.iter().map(Helper::source).collect()
    }
}
