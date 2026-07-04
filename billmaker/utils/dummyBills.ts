import { Bill } from "../types";

export const dummyBills: Bill[] = [
  {
    id: "1",
    billNumber: "BILL001",
    customerName: "Sharma Supplies",
    createdAt: new Date("2025-10-29"),
    updatedAt: new Date("2025-10-29"),
    products: [
      { id: "p1", prefix: "Box", quantity: "2", name: "Product A", price: "120" },
      { id: "p2", prefix: "Pieces", quantity: "1", name: "Product B", price: "350" },
      { id: "p3", prefix: "Pieces", quantity: "3", name: "Product C", price: "75" },
      { id: "p4", prefix: "Box", quantity: "2", name: "Product D", price: "200" },
      { id: "p5", prefix: "Pieces", quantity: "4", name: "Product E", price: "150" },
      { id: "p6", prefix: "Pieces", quantity: "2", name: "Product F", price: "180" },
      { id: "p7", prefix: "Box", quantity: "1", name: "Product G", price: "250" },
      { id: "p8", prefix: "Pieces", quantity: "5", name: "Product H", price: "60" },
      { id: "p9", prefix: "Box", quantity: "3", name: "Product I", price: "130" },
      { id: "p10", prefix: "Pieces", quantity: "6", name: "Product J", price: "55" },
      { id: "p11", prefix: "Box", quantity: "2", name: "Product K", price: "90" },
    ],
  },
  {
    id: "2",
    billNumber: "BILL002",
    customerName: "Local Mart",
    createdAt: new Date("2025-10-28"),
    updatedAt: new Date("2025-10-28"),
    products: Array.from({ length: 12 }).map((_, i) => ({
      id: `p${i + 1}`,
      prefix: i % 2 === 0 ? "Box" : "Pieces",
      quantity: `${i + 1}`,
      name: `Item ${i + 1}`,
      price: `${100 + i * 10}`,
    })),
  },
  {
    id: "3",
    billNumber: "BILL003",
    customerName: "Sharma Supplies",
    createdAt: new Date("2025-10-27"),
    updatedAt: new Date("2025-10-27"),
    products: Array.from({ length: 11 }).map((_, i) => ({
      id: `p${i + 1}`,
      prefix: i % 2 === 0 ? "Pieces" : "Box",
      quantity: `${i + 2}`,
      name: `Product ${i + 1}`,
      price: `${150 + i * 5}`,
    })),
  },
  {
    id: "4",
    billNumber: "BILL004",
    customerName: "Local Mart",
    createdAt: new Date("2025-10-26"),
    updatedAt: new Date("2025-10-26"),
    products: [
      { id: "p1", prefix: "Box", quantity: "1", name: "Rice 10kg", price: "550" },
      { id: "p2", prefix: "Box", quantity: "2", name: "Wheat 5kg", price: "250" },
      { id: "p3", prefix: "Pieces", quantity: "5", name: "Sugar 1kg", price: "45" },
      { id: "p4", prefix: "Pieces", quantity: "3", name: "Salt 1kg", price: "20" },
      { id: "p5", prefix: "Box", quantity: "2", name: "Oil 1L", price: "150" },
      { id: "p6", prefix: "Pieces", quantity: "10", name: "Biscuits", price: "10" },
      { id: "p7", prefix: "Box", quantity: "1", name: "Tea 1kg", price: "200" },
      { id: "p8", prefix: "Box", quantity: "1", name: "Coffee 1kg", price: "300" },
      { id: "p9", prefix: "Pieces", quantity: "12", name: "Soap", price: "25" },
      { id: "p10", prefix: "Pieces", quantity: "2", name: "Detergent 2kg", price: "180" },
      { id: "p11", prefix: "Pieces", quantity: "5", name: "Toothpaste", price: "60" },
    ],
  },
  {
    id: "5",
    billNumber: "BILL005",
    customerName: "Mega Wholesale Mart",
    createdAt: new Date("2025-10-25"),
    updatedAt: new Date("2025-10-25"),
    products: Array.from({ length: 25 }).map((_, i) => ({
      id: `p${i + 1}`,
      prefix: i % 2 === 0 ? "Box" : "Pieces",
      quantity: `${(i % 5) + 1}`,
      name: `Bulk Product ${i + 1}`,
      price: `${80 + i * 15}`,
    })),
  },

  // Bill 6 — Bulk Store
{
  id: "6",
  billNumber: "BILL006",
  customerName: "Bulk Store Traders",
  createdAt: new Date("2025-10-24"),
  updatedAt: new Date("2025-10-24"),
  products: Array.from({ length: 35 }).map((_, i) => ({
    id: `p${i + 1}`,
    prefix: i % 3 === 0 ? "Box" : "Pieces",
    quantity: `${(i % 8) + 1}`,
    name: `Wholesale Item ${i + 1}`,
    price: `${100 + i * 5}`,
  })),
},

// Bill 7 — Corporate Office Supply
{
  id: "7",
  billNumber: "BILL007",
  customerName: "Corporate Office Supply Co.",
  createdAt: new Date("2025-10-23"),
  updatedAt: new Date("2025-10-23"),
  products: Array.from({ length: 35 }).map((_, i) => ({
    id: `p${i + 1}`,
    prefix: i % 2 === 0 ? "Box" : "Pieces",
    quantity: `${(i % 6) + 1}`,
    name: `Stationery Product ${i + 1}`,
    price: `${50 + i * 8}`,
  })),
},

// Bill 8 — Grocery Warehouse
{
  id: "8",
  billNumber: "BILL008",
  customerName: "Grocery Warehouse Hub",
  createdAt: new Date("2025-10-22"),
  updatedAt: new Date("2025-10-22"),
  products: Array.from({ length: 35 }).map((_, i) => ({
    id: `p${i + 1}`,
    prefix: i % 2 === 1 ? "Box" : "Pieces",
    quantity: `${(i % 10) + 1}`,
    name: `Grocery Bulk Item ${i + 1}`,
    price: `${40 + i * 6}`,
  })),
},

// Bill 9 — Electronics Distributor
{
  id: "9",
  billNumber: "BILL009",
  customerName: "Electronics Distributor Godown",
  createdAt: new Date("2025-10-21"),
  updatedAt: new Date("2025-10-21"),
  products: Array.from({ length: 35 }).map((_, i) => ({
    id: `p${i + 1}`,
    prefix: i % 2 === 0 ? "Box" : "Pieces",
    quantity: `${(i % 4) + 1}`,
    name: `Electronic Component ${i + 1}`,
    price: `${200 + i * 20}`,
  })),
},

];
